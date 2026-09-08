const express = require('express');
const router = express.Router();
const usuariosDb = require('../db/usuarios');
const { enviarMailBrevo } = require('../services/brevo');
const { avisarUsuarioNuevo } = require('../services/avisosAdmin');
const { BASE_URL, ADMIN_EMAIL } = require('../config/env');
const { limitadorAuth } = require('../middleware/rateLimiters');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/registro', (req, res) => res.render('registro', { error: null }));

router.post('/registro', limitadorAuth, async (req, res) => {
    const { nombre, email, telefono, password } = req.body;

    if (!nombre || !email || !telefono || !password) {
        return res.render('registro', { error: 'Completá todos los campos.' });
    }
    if (!EMAIL_REGEX.test(email)) {
        return res.render('registro', { error: 'El mail no parece válido.' });
    }
    if (password.length < 8) {
        return res.render('registro', { error: 'La contraseña tiene que tener al menos 8 caracteres.' });
    }

    const existente = await usuariosDb.obtenerPorEmail(email);
    if (existente) {
        return res.render('registro', { error: 'Ya existe una cuenta con ese mail.' });
    }

    try {
        const { id, tokenVerificacion } = await usuariosDb.crearUsuario({ nombre, email, telefono, password });
        const linkVerificacion = `${BASE_URL}/verificar-email/${tokenVerificacion}`;

        // Aviso al admin apenas se guarda el usuario (no espera a que verifique el mail): la
        // idea es tener el control de quién entra a la plataforma en el momento. Sin await y
        // sin poder romper el registro — ver services/avisosAdmin.js.
        avisarUsuarioNuevo({ id, nombre, email, telefono });

        await enviarMailBrevo({
            to: email,
            subject: 'Confirmá tu mail',
            text: `¡Hola ${nombre}! Confirmá tu mail para poder crear eventos:\n\n${linkVerificacion}\n\nSi vos no pediste esto, ignorá este mensaje.`
        });

        res.render('registro-exitoso', { email });
    } catch (error) {
        console.error('Error al registrar usuario:', error);
        res.render('registro', { error: 'Hubo un error al crear tu cuenta. Probá de nuevo.' });
    }
});

router.get('/verificar-email/:token', async (req, res) => {
    const usuario = await usuariosDb.obtenerPorTokenVerificacion(req.params.token);
    if (!usuario) return res.status(400).send('Link de verificación inválido o ya usado.');

    const tokenAprobacion = await usuariosDb.marcarEmailVerificado(usuario.id);
    const linkAprobacion = `${BASE_URL}/admin/aprobar/${usuario.id}?token=${tokenAprobacion}`;

    try {
        await enviarMailBrevo({
            to: ADMIN_EMAIL,
            subject: `Nueva solicitud para crear eventos: ${usuario.nombre}`,
            text: `${usuario.nombre} confirmó su mail y quiere crear eventos.\n\nMail: ${usuario.email}\nTeléfono: ${usuario.telefono}\n\nSi confiás en esta persona, aprobala acá:\n${linkAprobacion}`
        });
    } catch (mailError) {
        console.error('No se pudo avisar al admin sobre la nueva solicitud:', mailError);
    }

    res.render('email-verificado');
});

// El admin hace click en este link DESDE EL MAIL para aprobar a un organizador nuevo — no
// necesita loguearse, el token largo y de un solo uso cumple esa función.
router.get('/admin/aprobar/:id', async (req, res) => {
    const usuario = await usuariosDb.obtenerPorTokenAprobacion(req.params.id, req.query.token);
    if (!usuario) return res.status(403).send('Link de aprobación inválido o ya usado.');

    await usuariosDb.aprobarUsuario(usuario.id);

    try {
        await enviarMailBrevo({
            to: usuario.email,
            subject: '¡Ya podés crear tu evento!',
            text: `¡Hola ${usuario.nombre}! Tu cuenta fue aprobada. Iniciá sesión en ${BASE_URL}/login y ya podés crear tu evento.`
        });
    } catch (mailError) {
        console.error('No se pudo avisar al usuario que fue aprobado:', mailError);
    }

    res.send(`Listo, aprobaste a ${usuario.nombre} (${usuario.email}). Ya le avisamos por mail.`);
});

router.get('/login', (req, res) => res.render('login', { error: null }));

router.post('/login', limitadorAuth, async (req, res) => {
    try {
        const { email, password } = req.body;
        const usuario = await usuariosDb.obtenerPorEmail(email);

        // Mensaje genérico a propósito: no hay que revelar si el mail existe o no.
        const credencialesInvalidas = () => res.render('login', { error: 'Mail o contraseña incorrectos.' });

        if (!usuario) return credencialesInvalidas();
        const passwordOk = await usuariosDb.verificarPassword(usuario, password || '');
        if (!passwordOk) return credencialesInvalidas();

        // Ya NO se bloquea el login por mail sin verificar: el usuario puede entrar, navegar
        // y crear eventos igual. Lo único que depende de verificar el mail es que sus eventos
        // lleguen a ser públicos (ver eventosDb.eventoEsPublico y el banner en el panel de
        // cada evento) — acá solo se le muestra un aviso sutil en el dashboard, no un bloqueo.
        req.session.usuarioId = usuario.id;
        req.session.nombre = usuario.nombre;
        req.session.rol = usuario.rol;
        // Se contemplan las DOS columnas (se mantienen sincronizadas en db/pool.js, pero
        // aceptar cualquiera evita dejar afuera a un admin legítimo si una quedó desfasada).
        // Ojo: esto es solo para DIBUJAR la interfaz. El permiso real lo decide el middleware
        // isAdmin, que relee al usuario de la base en cada pedido — un flag de sesión editado
        // o viejo no abre ninguna puerta.
        req.session.esAdmin = Boolean(usuario.is_admin || usuario.rol === 'admin');
        req.session.aprobado = !!usuario.aprobado;

        // Guardado explícito (en vez de dejarlo implícito) para poder loguear el error real
        // si el store de sesiones en MySQL falla, en vez de que el pedido se corte en silencio.
        req.session.save((err) => {
            if (err) {
                console.error('Error al guardar la sesión de login:', err);
                return res.render('login', { error: 'Hubo un error interno al iniciar sesión. Probá de nuevo.' });
            }
            res.redirect('/mis-eventos');
        });
    } catch (error) {
        console.error('Error en /login:', error);
        res.render('login', { error: 'Hubo un error interno. Probá de nuevo.' });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

router.get('/recuperar-password', (req, res) => res.render('recuperar-password', { enviado: false }));

router.post('/recuperar-password', limitadorAuth, async (req, res) => {
    const { email } = req.body;
    const usuario = await usuariosDb.obtenerPorEmail(email);

    // Mostramos el mismo mensaje exista o no la cuenta — no hay que revelar qué mails están registrados.
    if (usuario) {
        try {
            const token = await usuariosDb.generarTokenRecuperacion(usuario.id);
            const link = `${BASE_URL}/restablecer-password/${token}`;
            await enviarMailBrevo({
                to: usuario.email,
                subject: 'Recuperar tu contraseña',
                text: `Pediste restablecer tu contraseña. Este link vence en 1 hora:\n\n${link}\n\nSi no fuiste vos, ignorá este mensaje.`
            });
        } catch (error) {
            console.error('Error al mandar el mail de recuperación:', error);
        }
    }

    res.render('recuperar-password', { enviado: true });
});

router.get('/restablecer-password/:token', async (req, res) => {
    const usuario = await usuariosDb.obtenerPorTokenRecuperacion(req.params.token);
    if (!usuario) return res.status(400).send('Este link venció o ya fue usado. Pedí uno nuevo desde /recuperar-password.');
    res.render('restablecer-password', { token: req.params.token, error: null });
});

router.post('/restablecer-password/:token', async (req, res) => {
    const usuario = await usuariosDb.obtenerPorTokenRecuperacion(req.params.token);
    if (!usuario) return res.status(400).send('Este link venció o ya fue usado. Pedí uno nuevo desde /recuperar-password.');

    const { password } = req.body;
    if (!password || password.length < 8) {
        return res.render('restablecer-password', { token: req.params.token, error: 'La contraseña tiene que tener al menos 8 caracteres.' });
    }

    await usuariosDb.cambiarPassword(usuario.id, password);
    res.render('password-cambiada');
});

module.exports = router;
