import { Router } from 'express';
import pool from '../db/db.js';
import { auth, requerirRol } from '../middlewares/auth.js';
import webpush from '../config/webpush.js';

const router = Router();

/* POST /push-token */
router.post('/push-token', auth, async (req, res) => {
  const { token } = req.body;
  const id_dirigente = req.user.id_dirigente;

  if (!token) {
    return res.status(400).json({ error: 'Token requerido' });
  }

  try {
    await pool.query(
      `INSERT INTO push_tokens (id_dirigente, token)
       VALUES ($1, $2)
       ON CONFLICT (id_dirigente, token) DO NOTHING`,
      [id_dirigente, token]
    );

    res.json({ mensaje: 'Push token registrado' });
  } catch (err) {
    console.error('Error guardando push token:', err);
    res.status(500).json({ error: 'Error al guardar push token' });
  }
});

/* POST /push-token/web */
router.post('/push-token/web', auth, async (req, res) => {
  const { subscription } = req.body;
  const id_dirigente = req.user.id_dirigente;

  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }

  try {
    await pool.query(
      `INSERT INTO web_push_subscriptions (id_dirigente, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id_dirigente, endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [id_dirigente, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );

    res.json({ mensaje: 'Suscripción web registrada' });
  } catch (err) {
    console.error('Error guardando suscripción web:', err);
    res.status(500).json({ error: 'Error al guardar suscripción' });
  }
});

/* POST /notificacion/recordatorio-tribu */
router.post('/notificacion/recordatorio-tribu', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  try {
    const [expoResult, webResult] = await Promise.all([
      pool.query(`SELECT DISTINCT token FROM push_tokens`),
      pool.query(`SELECT id, endpoint, p256dh, auth FROM web_push_subscriptions`),
    ]);

    const expoTokens = expoResult.rows.map(r => r.token);
    const webSubs = webResult.rows;

    if (expoTokens.length === 0 && webSubs.length === 0) {
      return res.status(400).json({
        error: 'No hay dispositivos registrados para recibir notificaciones'
      });
    }

    let enviados = 0;
    let errores = 0;

    if (expoTokens.length > 0) {
      const messages = expoTokens.map(token => ({
        to: token,
        sound: 'default',
        title: 'Recordatorio de Asistencia',
        body: 'RECUERDA TOMAR LA ASISTENCIA DE LA TRIBU',
        data: { tipo: 'recordatorio_tribu' },
      }));

      const chunks = [];
      for (let i = 0; i < messages.length; i += 100) {
        chunks.push(messages.slice(i, i + 100));
      }

      for (const chunk of chunks) {
        try {
          const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Accept-encoding': 'gzip, deflate',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(chunk),
          });

          const data = await response.json();

          if (data.data) {
            data.data.forEach(ticket => {
              if (ticket.status === 'ok') enviados++;
              else errores++;
            });
          }
        } catch (err) {
          console.error('Error enviando chunk de notificaciones Expo:', err);
          errores += chunk.length;
        }
      }
    }

    if (webSubs.length > 0) {
      const payload = JSON.stringify({
        title: 'Recordatorio de Asistencia',
        body: 'RECUERDA TOMAR LA ASISTENCIA DE LA TRIBU',
        data: { tipo: 'recordatorio_tribu' },
      });

      await Promise.all(webSubs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          enviados++;
        } catch (err) {
          errores++;
          if (err.statusCode === 404 || err.statusCode === 410) {
            await pool.query('DELETE FROM web_push_subscriptions WHERE id = $1', [sub.id]);
          } else {
            console.error('Error enviando web push:', err.message);
          }
        }
      }));
    }

    res.json({
      mensaje: 'Notificaciones enviadas',
      enviados,
      errores,
      total_dispositivos: expoTokens.length + webSubs.length,
    });

  } catch (err) {
    console.error('Error enviando notificaciones:', err);
    res.status(500).json({ error: 'Error al enviar notificaciones' });
  }
});

export default router;
