import 'dotenv/config';
import path from 'path';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import webpush from 'web-push';

import pool from './db.js';
import auth from './auth.js';

webpush.setVapidDetails(
  'mailto:[exodojpll29@gmail.com]',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.use(
  '/uploads',
  express.static(path.join(process.cwd(), 'uploads'))
);

/* Auto-crear tabla push_tokens si no existe */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id SERIAL PRIMARY KEY,
        id_dirigente INTEGER REFERENCES dirigente(id_dirigente) ON DELETE CASCADE,
        token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(id_dirigente, token)
      );
    `);
    console.log('Tabla push_tokens lista');
  } catch (err) {
    console.error('Error creando tabla push_tokens:', err.message);
  }
})();

/* Auto-crear tabla web_push_subscriptions si no existe (notificaciones web) */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS web_push_subscriptions (
        id SERIAL PRIMARY KEY,
        id_dirigente INTEGER REFERENCES dirigente(id_dirigente) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(id_dirigente, endpoint)
      );
    `);
    console.log('Tabla web_push_subscriptions lista');
  } catch (err) {
    console.error('Error creando tabla web_push_subscriptions:', err.message);
  }
})();

function generarContrasena(longitud = 9) {
  const mayus = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const minus = 'abcdefghijklmnopqrstuvwxyz';
  const numeros = '0123456789';
  const todos = mayus + minus + numeros;

  let contrasena =
    mayus[Math.floor(Math.random() * mayus.length)] +
    minus[Math.floor(Math.random() * minus.length)] +
    numeros[Math.floor(Math.random() * numeros.length)];

  for (let i = contrasena.length; i < longitud; i++) {
    contrasena += todos[Math.floor(Math.random() * todos.length)];
  }

  return contrasena.split('').sort(() => 0.5 - Math.random()).join('');
}

async function generarCodigoUnico(client) {
  let codigo;
  let existe = true;

  while (existe) {
    codigo = generarCodigo();
    const check = await client.query(
      'SELECT 1 FROM dirigente WHERE codigo = $1',
      [codigo]
    );
    existe = check.rowCount > 0;
  }

  return codigo;
}

function generarCodigo(min = 2000000, max = 29999999) {
  return Math.floor(Math.random() * (max - min + 1) + min).toString();
}

/* Login */
app.post('/login', async (req, res) => {
  const { usuario, contrasena } = req.body;
  try {
    const result = await pool.query(
      `SELECT d.*, t.nombre AS nombre_tribu, t.drive AS tribu_drive
       FROM dirigente d
       LEFT JOIN tribu t ON t.id_tribu = d.id_tribu
       WHERE d.usuario = $1`,
      [usuario]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const dirigente = result.rows[0];

    const valido = await bcrypt.compare(contrasena, dirigente.contrasena);
    if (!valido) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      {
        id_dirigente: dirigente.id_dirigente,
        nombre: dirigente.nombre,
        segundo_nombre: dirigente.segundo_nombre,
        apellido: dirigente.apellido,
        rol: dirigente.rol,
        comite: dirigente.comite,
        id_tribu: dirigente.id_tribu,
        codigo: dirigente.codigo,
        foto: dirigente.foto
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      dirigente: {
        id_dirigente: dirigente.id_dirigente,
        nombre: dirigente.nombre,
        segundo_nombre: dirigente.segundo_nombre,
        apellido: dirigente.apellido,
        rol: dirigente.rol,
        comite: dirigente.comite,
        id_tribu: dirigente.id_tribu,
        id_tribu_secundaria: dirigente.id_tribu_secundaria || null,
        tribu: dirigente.nombre_tribu,
        drive: dirigente.tribu_drive,
        codigo: dirigente.codigo,
        foto: dirigente.foto
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error en login' });
  }
});

app.post('/dirigente', async (req, res) => {
  const { nombre, segundo_nombre, apellido, rol, comite, id_tribu } = req.body;

  if (!nombre || !apellido || !rol) {
    return res.status(400).json({ message: 'Faltan datos obligatorios' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const contrasenaPlano = generarContrasena();
    const codigo = await generarCodigoUnico(client);
    const contrasenaHash = await bcrypt.hash(contrasenaPlano, 12);
    
    const dirigenteResult = await client.query(
      `
      INSERT INTO dirigente
      (nombre, segundo_nombre, apellido, rol, comite, id_tribu, contrasena, codigo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        nombre,
        segundo_nombre && segundo_nombre.trim() !== '' ? segundo_nombre : null,
        apellido,
        rol,
        comite,
        id_tribu,
        contrasenaHash,
        codigo
      ]
    );

    const dirigente = dirigenteResult.rows[0];

    const usuarioGenerado =
      nombre.replace(/\s+/g, '') +
      apellido.replace(/\s+/g, '') +
      dirigente.id_dirigente;

    await client.query(
      `
      UPDATE dirigente
      SET usuario = $1
      WHERE id_dirigente = $2
      `,
      [usuarioGenerado, dirigente.id_dirigente]
    );

    const codigoQR = `DIR-${dirigente.nombre}-${dirigente.apellido}-${dirigente.id_dirigente}`;
    const tokenSecreto = crypto.randomBytes(16).toString('hex');

    await client.query(
      `
      INSERT INTO qr_personal
      (id_dirigente, codigo_qr, token_secreto)
      VALUES ($1,$2,$3)
      `,
      [dirigente.id_dirigente, codigoQR, tokenSecreto]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Dirigente creado correctamente',
      dirigente: {
        id_dirigente: dirigente.id_dirigente,
        nombre: dirigente.nombre,
        apellido: dirigente.apellido,
        usuario: usuarioGenerado,
        contrasena: contrasenaPlano,
        codigo: codigo,
        rol: dirigente.rol,
        comite: dirigente.comite,
        id_tribu: dirigente.id_tribu,
        codigo_qr: codigoQR
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando dirigente:', error.message);
    return res.status(500).json({
      message: 'Error creando dirigente',
      error: error.message,
      detail: error.detail,
    });
  } finally {
    client.release();
  }
});

app.get('/dirigente/:id/qr', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT codigo_qr
      FROM qr_personal
      WHERE id_dirigente = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'QR no encontrado' });
    }

    res.json({ codigo_qr: result.rows[0].codigo_qr });

  } catch (error) {
    console.error('Error obteniendo QR:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.get('/dirigentes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id_dirigente, nombre, segundo_nombre, apellido, rol, comite, id_tribu, id_tribu_secundaria, foto
      FROM dirigente
      ORDER BY nombre ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo dirigentes:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.put('/dirigente/:id', async (req, res) => {
  const { id } = req.params;
  const { rol, comite, id_tribu, id_tribu_secundaria } = req.body;

  if (!rol) {
    return res.status(400).json({ message: 'El rol es obligatorio' });
  }

  try {
    const result = await pool.query(
      `
      UPDATE dirigente
      SET rol = $1, comite = $2, id_tribu = $3, id_tribu_secundaria = $4
      WHERE id_dirigente = $5
      RETURNING id_dirigente, nombre, apellido, rol, comite, id_tribu, id_tribu_secundaria
      `,
      [rol, comite || null, id_tribu || null, id_tribu_secundaria || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Dirigente no encontrado' });
    }

    res.json({
      message: 'Dirigente actualizado',
      dirigente: result.rows[0],
    });
  } catch (error) {
    console.error('Error actualizando dirigente:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.delete('/dirigente/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const check = await client.query(
      'SELECT nombre, apellido FROM dirigente WHERE id_dirigente = $1',
      [id]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Dirigente no encontrado' });
    }

    await client.query('DELETE FROM multa WHERE id_dirigente = $1', [id]);
    await client.query('DELETE FROM asistencia WHERE id_dirigente = $1', [id]);
    await client.query('DELETE FROM qr_personal WHERE id_dirigente = $1', [id]);
    await client.query('DELETE FROM dirigente WHERE id_dirigente = $1', [id]);

    await client.query('COMMIT');

    res.json({
      message: 'Dirigente eliminado',
      dirigente: check.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando dirigente:', error);
    res.status(500).json({ message: 'Error del servidor' });
  } finally {
    client.release();
  }
});

app.put('/dirigente/:id/contrasena', async (req, res) => {
  const { id } = req.params;
  const { contrasenaActual, contrasenaNueva } = req.body;

  if (!contrasenaActual || !contrasenaNueva) {
    return res.status(400).json({ message: 'Datos incompletos' });
  }

  try {
    const result = await pool.query(
      `SELECT contrasena FROM dirigente WHERE id_dirigente = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Dirigente no encontrado' });
    }

    const valida = await bcrypt.compare(contrasenaActual, result.rows[0].contrasena);
    if (!valida) {
      return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    }

    const hash = await bcrypt.hash(contrasenaNueva, 12);
    await pool.query(
      `UPDATE dirigente SET contrasena = $1 WHERE id_dirigente = $2`,
      [hash, id]
    );

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    console.error('Error actualizando contraseña:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.get('/tribus', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id_tribu, nombre, puntos, color_hex, drive FROM tribu ORDER BY id_tribu'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo tribus:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.post('/tribu/puntos', async (req, res) => {
  const { id_tribu, puntos } = req.body;
  if (typeof id_tribu !== 'number' || typeof puntos !== 'number') {
    return res.status(400).json({ message: 'Datos inválidos' });
  }
  try {
    const result = await pool.query(
      `
      UPDATE tribu
      SET puntos = puntos + $1
      WHERE id_tribu = $2
      RETURNING puntos
      `,
      [puntos, id_tribu]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Tribu no encontrada' });
    }

    res.json({
      message: 'Puntos actualizados',
      puntos: result.rows[0].puntos,
    });
  } catch (error) {
    console.error('Error actualizando puntos:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.get('/asistencia/exoditos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.nombre AS tribu,
        e.id_exodito,
        e.nombre AS exodito,
        ARRAY_AGG(a.fecha ORDER BY a.fecha) AS fechas
      FROM asistencia_exodito a
      JOIN exodito e ON e.id_exodito = a.id_exodito
      JOIN tribu t ON t.id_tribu = e.id_tribu
      WHERE a.estado = 'Presente'
      GROUP BY t.nombre, e.id_exodito, e.nombre
      ORDER BY t.nombre, e.nombre
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error asistencia exoditos:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.post('/asistencia/qr', auth, async (req, res) => {
  const { codigo_qr } = req.body;

  if (!codigo_qr) {
    return res.status(400).json({ error: 'Código QR requerido' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const qrResult = await client.query(
      `SELECT *
       FROM qr_personal
       WHERE codigo_qr = $1
       AND fecha_expiracion >= CURRENT_DATE`,
      [codigo_qr]
    );

    if (qrResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'QR inválido o expirado' });
    }

    const qr = qrResult.rows[0];

    const existe = await client.query(
      `SELECT 1
       FROM asistencia
       WHERE id_dirigente = $1
       AND fecha = CURRENT_DATE`,
      [qr.id_dirigente]
    );

    if (existe.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Asistencia ya registrada hoy' });
    }

    const asistencia = await client.query(
      `INSERT INTO asistencia
       (id_dirigente, fecha, hora_llegada, estado, metodo_registro)
       VALUES ($1, CURRENT_DATE, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::time, 'Presente', 'QR')
       RETURNING *`,
      [qr.id_dirigente]
    );

    await client.query(
      `UPDATE qr_personal
       SET veces_usado = COALESCE(veces_usado, 0) + 1,
           ultimo_uso = CURRENT_TIMESTAMP
       WHERE id_qr = $1`,
      [qr.id_qr]
    );

    await client.query('COMMIT');

    res.json({
      mensaje: 'Asistencia registrada correctamente',
      asistencia: asistencia.rows[0]
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR ASISTENCIA QR:', err);
    res.status(500).json({
      error: 'Error al registrar asistencia',
      detalle: err.message
    });
  } finally {
    client.release();
  }
});

app.post('/asistencia/manual', auth, async (req, res) => {
  const { codigo } = req.body;

  if (!codigo) {
    return res.status(400).json({ error: 'Código requerido' });
  }

  try {
    const dirigente = await pool.query(
      `SELECT id_dirigente FROM dirigente WHERE codigo = $1`,
      [codigo]
    );

    if (dirigente.rows.length === 0) {
      return res.status(404).json({ error: 'Código inválido' });
    }

    const id_dirigente = dirigente.rows[0].id_dirigente;

    const existe = await pool.query(
      `SELECT 1 FROM asistencia
       WHERE id_dirigente = $1 AND fecha = CURRENT_DATE`,
      [id_dirigente]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Asistencia ya registrada hoy' });
    }

    const result = await pool.query(
      `INSERT INTO asistencia
       (id_dirigente, hora_llegada, estado, metodo_registro)
       VALUES ($1, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::time, 'Presente', 'Manual')
       RETURNING *`,
      [id_dirigente]
    );

    res.json({
      mensaje: 'Asistencia registrada',
      asistencia: result.rows[0],
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al registrar asistencia manual' });
  }
});

app.get('/asistencia/fecha/:fecha', auth, async (req, res) => {
  const { fecha } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT 
        d.id_dirigente, d.nombre, d.apellido, d.rol, d.foto,
        a.id_asistencia, a.estado, a.metodo_registro, a.hora_llegada
      FROM dirigente d
      LEFT JOIN asistencia a
        ON d.id_dirigente = a.id_dirigente
        AND a.fecha = $1
      ORDER BY d.nombre
      `,
      [fecha]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener asistencia' });
  }
});

app.put('/asistencia', auth, async (req, res) => {
  const { id_dirigente, fecha, estado } = req.body;

  if (!id_dirigente || !fecha || !estado) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    if (estado === 'Presente') {
      await pool.query(
        `INSERT INTO asistencia
         (id_dirigente, fecha, hora_llegada, estado, metodo_registro)
         VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::time, 'Presente', 'Manual')
         ON CONFLICT (id_dirigente, fecha) DO UPDATE SET estado = 'Presente'`,
        [id_dirigente, fecha]
      );
    } else {
      await pool.query(
        `DELETE FROM asistencia WHERE id_dirigente = $1 AND fecha = $2`,
        [id_dirigente, fecha]
      );
    }

    res.json({ mensaje: 'Asistencia actualizada' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar asistencia' });
  }
});

app.get('/multas', auth, async (req, res) => {
  try {
    const result = await pool.query(
      ` SELECT m.id_multa, m.fecha, m.monto, m.motivo, m.detalle, m.id_dirigente, d.nombre, d.apellido, d.comite 
        FROM multa m 
        JOIN dirigente d ON m.id_dirigente = d.id_dirigente 
        ORDER BY m.fecha DESC `
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener multas' });
  }
});

app.get('/multas/dirigente/:id', auth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT id_multa, fecha, monto, motivo, detalle, id_dirigente
      FROM multa
      WHERE id_dirigente = $1
      ORDER BY fecha DESC
      `,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener multas del dirigente' });
  }
});

app.post('/multas', auth, async (req, res) => {
  const { id_dirigente, Detalle, monto, motivo } = req.body;

  if (!id_dirigente || !monto || !motivo) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO multa (id_dirigente, detalle, monto, motivo)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id_dirigente, Detalle || null, monto, motivo]
    );

    res.json({
      mensaje: 'Multa registrada correctamente',
      multa: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar multa' });
  }
});

app.delete('/multa/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM multa WHERE id_multa = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Multa no encontrada' });
    }
    res.json({
      mensaje: 'Multa eliminada correctamente',
      multa: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar multa' });
  }
});

app.get('/exoditos', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT e.id_exodito, e.nombre, e.apellido, e.cargo, e.id_tribu, t.nombre AS tribu
      FROM exodito e
      JOIN tribu t ON e.id_tribu = t.id_tribu
      ORDER BY e.nombre
      `
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener exoditos' });
  }
});

app.get('/exoditos/tribu/:id_tribu', auth, async (req, res) => {
  const { id_tribu } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM exodito WHERE id_tribu = $1 ORDER BY nombre`,
      [id_tribu]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener exoditos por tribu' });
  }
});

app.post('/exoditos', auth, async (req, res) => {
  const { nombre, apellido, cargo, id_tribu } = req.body;

  if (!nombre || !apellido || !id_tribu) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO exodito (nombre, apellido, cargo, id_tribu)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [nombre, apellido, cargo || null, id_tribu]
    );

    res.json({
      mensaje: 'Exodito creado correctamente',
      exodito: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear exodito' });
  }
});

app.put('/exodito/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { nombre, apellido, cargo, id_tribu } = req.body;
  if (!nombre || !apellido || !id_tribu) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  try {
    const result = await pool.query(
      `UPDATE exodito
        SET nombre = $1, apellido = $2, cargo = $3, id_tribu = $4
        WHERE id_exodito = $5
        RETURNING *`,
      [nombre, apellido, cargo || null, id_tribu, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Exodito no encontrado' });
    }

    res.json({
      mensaje: 'Exodito actualizado correctamente',
      exodito: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar exodito' });
  }
});

app.delete('/exodito/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM exodito WHERE id_exodito = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Exodito no encontrado' });
    }
    res.json({
      mensaje: 'Exodito eliminado correctamente',
      exodito: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar exodito' });
  }
});

app.get('/asistencia/exoditos/:fecha', auth, async (req, res) => {
  const { fecha } = req.params;

  try {
    const result = await pool.query(`
      SELECT
        t.nombre AS tribu, e.id_exodito, e.nombre, e.apellido, e.cargo, ae.estado
      FROM exodito e
      JOIN tribu t ON t.id_tribu = e.id_tribu
      LEFT JOIN asistencia_exodito ae
        ON ae.id_exodito = e.id_exodito AND ae.fecha = $1
      ORDER BY t.id_tribu ASC, e.nombre ASC
    `, [fecha]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener asistencia' });
  }
});

app.post('/asistencia/exoditos', auth, async (req, res) => {
  const { asistencias, fecha } = req.body;

  if (!Array.isArray(asistencias) || asistencias.length === 0) {
    return res.status(400).json({ error: 'No hay asistencias para registrar' });
  }

  const fechaRegistro = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)
    ? fecha
    : new Date().toISOString().slice(0, 10);

  try {
    const queries = asistencias.map(({ id_exodito, estado }) => {
      if (estado === 'Presente') {
        return pool.query(
          `INSERT INTO asistencia_exodito (id_exodito, fecha, estado)
           VALUES ($1, $2, 'Presente')
           ON CONFLICT (id_exodito, fecha) DO UPDATE SET estado = 'Presente'`,
          [id_exodito, fechaRegistro]
        );
      } else {
        return pool.query(
          `DELETE FROM asistencia_exodito WHERE id_exodito = $1 AND fecha = $2`,
          [id_exodito, fechaRegistro]
        );
      }
    });

    await Promise.all(queries);

    res.json({
      message: 'Asistencia de exoditos registrada correctamente',
      total: asistencias.length,
      fecha: fechaRegistro,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar asistencia de exoditos' });
  }
});

app.delete('/asistencia/exoditos', auth, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM asistencia_exodito`);
    res.json({
      mensaje: 'Asistencia de exoditos eliminada',
      eliminados: result.rowCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar asistencia de exoditos' });
  }
});

app.delete('/asistencia/dirigentes', auth, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM asistencia`);
    res.json({
      mensaje: 'Asistencia de dirigentes eliminada',
      eliminados: result.rowCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar asistencia de dirigentes' });
  }
});

app.post('/push-token', auth, async (req, res) => {
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

app.post('/push-token/web', auth, async (req, res) => {
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

app.post('/notificacion/recordatorio-tribu', auth, async (req, res) => {
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

app.get('/asistencia/reporte-tribus', auth, async (req, res) => {
  const { desde, hasta } = req.query;

  if (!desde || !hasta) {
    return res.status(400).json({ error: 'Se requieren los parámetros "desde" y "hasta"' });
  }

  try {
    const result = await pool.query(`
      WITH
      fechas_exo AS (
        SELECT DISTINCT fecha FROM asistencia_exodito
        WHERE fecha BETWEEN $1 AND $2
      ),
      presentes_exo AS (
        SELECT e.id_tribu, COUNT(*) AS presentes
        FROM asistencia_exodito ae
        JOIN exodito e ON e.id_exodito = ae.id_exodito
        WHERE ae.fecha BETWEEN $1 AND $2 AND e.id_tribu IS NOT NULL
        GROUP BY e.id_tribu
      ),
      posibles_exo AS (
        SELECT e.id_tribu,
               COUNT(DISTINCT e.id_exodito) * (SELECT COUNT(*) FROM fechas_exo) AS posibles
        FROM exodito e
        WHERE e.id_tribu IS NOT NULL
        GROUP BY e.id_tribu
      )
      SELECT
        t.id_tribu, t.nombre, t.color_hex,
        COALESCE(pe.presentes, 0) AS total_presentes,
        COALESCE(poe.posibles, 0) AS total_posibles,
        CASE
          WHEN COALESCE(poe.posibles, 0) = 0 THEN 0
          ELSE ROUND(COALESCE(pe.presentes, 0)::numeric / COALESCE(poe.posibles, 0) * 100, 1)
        END AS porcentaje
      FROM tribu t
      LEFT JOIN presentes_exo pe ON pe.id_tribu = t.id_tribu
      LEFT JOIN posibles_exo poe ON poe.id_tribu = t.id_tribu
      WHERE COALESCE(poe.posibles, 0) > 0
      ORDER BY porcentaje DESC, total_presentes DESC
      LIMIT 5
    `, [desde, hasta]);

    res.json({ tribus: result.rows, desde, hasta });
  } catch (err) {
    console.error('Error en reporte-tribus:', err);
    res.status(500).json({ error: 'Error al generar el reporte' });
  }
});

app.get('/actividades', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM actividades ORDER BY fecha ASC');
    res.json(result.rows); 
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las actividades' });
  }
});

app.post('/actividades', async (req, res) => {
  const { titulo, descripcion, fecha, responsable, tipo } = req.body;

  if (!titulo || !fecha) {
    return res.status(400).json({ error: 'Faltan datos obligatorios: titulo y fecha' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO actividades (titulo, descripcion, fecha, responsable, tipo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [titulo, descripcion || null, fecha, responsable || null, tipo || 'Otro']
    );

    res.status(201).json({
      mensaje: 'Actividad creada correctamente',
      actividad: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la actividad' });
  }
});

app.get('/materiales', async (req, res) => {
  try {
    const query = `
      SELECT 
        m.id_material, m.nombre_material, m.cantidad, m.id_dirigente,
        CONCAT(d.nombre, ' ', d.apellido) AS responsable
      FROM materiales m
      LEFT JOIN dirigente d ON m.id_dirigente = d.id_dirigente
      ORDER BY m.nombre_material ASC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al consultar materiales:', error);
    res.status(500).json({ error: 'Error al obtener el inventario de materiales' });
  }
});

app.post('/materiales', async (req, res) => {
  const { nombre_material, cantidad, id_dirigente } = req.body;

  if (!nombre_material || cantidad === undefined || isNaN(parseInt(cantidad))) {
    return res.status(400).json({ error: 'El nombre del material y una cantidad válida son obligatorios' });
  }

  const dirigenteId = (id_dirigente && !isNaN(parseInt(id_dirigente))) ? parseInt(id_dirigente) : null;

  try {
    const query = `
      INSERT INTO materiales (nombre_material, cantidad, id_dirigente)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    const values = [nombre_material.trim(), parseInt(cantidad), dirigenteId];
    const result = await pool.query(query, values);

    res.status(201).json({
      mensaje: 'Material registrado exitosamente',
      material: result.rows[0]
    });
  } catch (error) {
    console.error('Error al insertar material:', error);
    res.status(500).json({ error: 'Error al guardar el material' });
  }
});

app.put('/materiales/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre_material, cantidad, id_dirigente } = req.body;

  try {
    const dirigenteId = (id_dirigente && !isNaN(parseInt(id_dirigente))) ? parseInt(id_dirigente) : null;

    const query = `
      UPDATE materiales
      SET nombre_material = COALESCE($1, nombre_material),
          cantidad = COALESCE($2, cantidad),
          id_dirigente = COALESCE($3, id_dirigente)
      WHERE id_material = $4
      RETURNING *
    `;
    const values = [
      nombre_material ? nombre_material.trim() : null,
      cantidad !== undefined && !isNaN(parseInt(cantidad)) ? parseInt(cantidad) : null,
      dirigenteId,
      id
    ];
    
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }

    res.json({
      mensaje: 'Material actualizado correctamente',
      material: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar material:', error);
    res.status(500).json({ error: 'Error al actualizar el material' });
  }
});

app.delete('/materiales/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM materiales WHERE id_material = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }

    res.json({ mensaje: 'Material eliminado del inventario' });
  } catch (error) {
    console.error('Error al eliminar material:', error);
    res.status(500).json({ error: 'Error al eliminar el material' });
  }
});

app.post('/actividades/:id/confirmar', async (req, res) => {
  const { id } = req.params;
  const { id_dirigente, estado } = req.body; 

  try {
    const query = `
      INSERT INTO asistencia_actividad (id_actividad, id_dirigente, estado)
      VALUES ($1, $2, $3)
      ON CONFLICT (id_actividad, id_dirigente) 
      DO UPDATE SET estado = EXCLUDED.estado;
    `;
    
    await pool.query(query, [id, id_dirigente, estado]);
    res.json({ message: 'Asistencia registrada correctamente' });
  } catch (error) {
    console.error('Error guardando asistencia:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/actividades/:id/asistentes', async (req, res) => {
  const { id } = req.params;
  try {
    const query = `
      SELECT d.id_dirigente, d.nombre, d.apellido, d.foto, aa.estado
      FROM asistencia_actividad aa
      JOIN dirigente d ON aa.id_dirigente = d.id_dirigente
      WHERE aa.id_actividad = $1
    `;
    const result = await pool.query(query, [id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo asistentes:', error);
    res.status(500).json({ error: 'Error al obtener asistentes' });
  }
});

/* Railway */
app.listen(PORT, '0.0.0.0', () => {
  console.log('Servidor escuchando en puerto', PORT);
});