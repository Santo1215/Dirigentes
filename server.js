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
  process.env.VAPID_SUBJECT || 'mailto:cambia-esto@tu-dominio.com',
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
    console.log('✅ Tabla push_tokens lista');
  } catch (err) {
    console.error('❌ Error creando tabla push_tokens:', err.message);
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
    console.log('✅ Tabla web_push_subscriptions lista');
  } catch (err) {
    console.error('❌ Error creando tabla web_push_subscriptions:', err.message);
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
  const {
    nombre,
    segundo_nombre,
    apellido,
    rol,
    comite,
    id_tribu,
  } = req.body;

  // 🔒 Validación mínima
  if (!nombre || !apellido || !rol) {
    return res.status(400).json({ message: 'Faltan datos obligatorios' });
  }

  const client = await pool.connect();

  try {


    await client.query('BEGIN');

    /* Crear dirigente SIN usuario */
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

    /* Generar usuario automático: NombreApellidoID */
    const usuarioGenerado =
      nombre.replace(/\s+/g, '') +
      apellido.replace(/\s+/g, '') +
      dirigente.id_dirigente;

    /* Actualizar dirigente con el usuario */
    await client.query(
      `
      UPDATE dirigente
      SET usuario = $1
      WHERE id_dirigente = $2
      `,
      [usuarioGenerado, dirigente.id_dirigente]
    );

    /* Generar QR personal */
    const codigoQR = `DIR-${dirigente.nombre}-${dirigente.apellido}-${dirigente.id_dirigente}`;
    const tokenSecreto = crypto.randomBytes(16).toString('hex');

    /*  Guardar QR */
    await client.query(
      `
      INSERT INTO qr_personal
      (id_dirigente, codigo_qr, token_secreto)
      VALUES ($1,$2,$3)
      `,
      [dirigente.id_dirigente, codigoQR, tokenSecreto]
    );

    await client.query('COMMIT');

    /*  Respuesta limpia */
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
    console.error('Error creando dirigente');
    console.error(error.message);
    console.error(error.detail);
    return res.status(500).json({
      message: 'Error creando dirigente',
      error: error.message,
      detail: error.detail,
    });
  } finally {
    client.release();
  }
});

/* Obtener QR personal del dirigente */
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

    res.json({
      codigo_qr: result.rows[0].codigo_qr
    });

  } catch (error) {
    console.error('❌ Error obteniendo QR:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/* Obtener todos los dirigentes */
app.get('/dirigentes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id_dirigente,
        nombre,
        segundo_nombre,
        apellido,
        rol,
        comite,
        id_tribu,
        id_tribu_secundaria,
        foto
      FROM dirigente
      ORDER BY nombre ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(' Error obteniendo dirigentes:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/*  Actualizar rol y comité de un dirigente */
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
    console.error(' Error actualizando dirigente:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/* Eliminar dirigente */
app.delete('/dirigente/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verificar que el dirigente existe
    const check = await client.query(
      'SELECT nombre, apellido FROM dirigente WHERE id_dirigente = $1',
      [id]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Dirigente no encontrado' });
    }

    // Eliminar registros dependientes en orden
    await client.query('DELETE FROM multa WHERE id_dirigente = $1', [id]);
    await client.query('DELETE FROM asistencia WHERE id_dirigente = $1', [id]);
    await client.query('DELETE FROM qr_personal WHERE id_dirigente = $1', [id]);

    // Ahora sí eliminar el dirigente
    await client.query('DELETE FROM dirigente WHERE id_dirigente = $1', [id]);

    await client.query('COMMIT');

    res.json({
      message: 'Dirigente eliminado',
      dirigente: check.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error eliminando dirigente:', error);
    res.status(500).json({ message: 'Error del servidor' });
  } finally {
    client.release();
  }
});

/* Actualizar contraseña de un dirigente */
app.put('/dirigente/:id/contrasena', async (req, res) => {
  const { id } = req.params;
  const { contrasenaActual, contrasenaNueva } = req.body;

  if (!contrasenaActual || !contrasenaNueva) {
    return res.status(400).json({ message: 'Datos incompletos' });
  }

  try {
    // Buscar dirigente
    const result = await pool.query(
      `SELECT contrasena FROM dirigente WHERE id_dirigente = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Dirigente no encontrado' });
    }

    // Validar contraseña actual
    const contrasenaDB = result.rows[0].contrasena;
    const valida = await bcrypt.compare(contrasenaActual, contrasenaDB);

    if (!valida) {
      return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    }

    // Encriptar nueva contraseña
    const hash = await bcrypt.hash(contrasenaNueva, 12);

    // Actualizar
    await pool.query(
      `UPDATE dirigente SET contrasena = $1 WHERE id_dirigente = $2`,
      [hash, id]
    );

    res.json({ message: 'Contraseña actualizada correctamente' });

  } catch (error) {
    console.error('❌ Error actualizando contraseña:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// GET /tribus
app.get('/tribus', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id_tribu, nombre, puntos, color_hex, drive FROM tribu ORDER BY id_tribu'
    );
    res.json(result.rows);
  } catch (error) {
    console.error(' Error obteniendo tribus:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Post /tribu/puntos
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
    console.error('❌ Error actualizando puntos:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// GET /asistencia/exoditos
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
    console.error('❌ Error asistencia exoditos:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// POST /asistencia/exoditos
app.post('/asistencia/exoditos', auth, async (req, res) => {
  const { asistencias, fecha } = req.body;

  if (!Array.isArray(asistencias) || asistencias.length === 0) {
    return res.status(400).json({ error: 'No hay asistencias para registrar' });
  }

  // Usar la fecha local enviada por el cliente (YYYY-MM-DD).
  // Si no viene, usar CURRENT_DATE del servidor como fallback.
  const fechaRegistro = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)
    ? fecha
    : new Date().toISOString().slice(0, 10);

  try {
    const queries = asistencias.map(({ id_exodito, estado }) =>
      pool.query(
        `
        INSERT INTO asistencia_exodito (id_exodito, fecha, estado)
        VALUES ($1, $2, $3)
        ON CONFLICT (id_exodito, fecha) DO UPDATE
        SET estado = EXCLUDED.estado
        `,
        [id_exodito, fechaRegistro, estado]
      )
    );

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


//Asistencia via QR
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
    // Buscar dirigente por código
    const dirigente = await pool.query(
      `SELECT id_dirigente FROM dirigente WHERE codigo = $1`,
      [codigo]
    );

    if (dirigente.rows.length === 0) {
      return res.status(404).json({ error: 'Código inválido' });
    }

    const id_dirigente = dirigente.rows[0].id_dirigente;

    // Verificar si ya marcó hoy
    const existe = await pool.query(
      `SELECT 1 FROM asistencia
       WHERE id_dirigente = $1 AND fecha = CURRENT_DATE`,
      [id_dirigente]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Asistencia ya registrada hoy' });
    }

    // Registrar asistencia
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
        d.id_dirigente,
        d.nombre,
        d.apellido,
        d.rol,
        a.id_asistencia,
        a.estado,
        a.metodo_registro,
        a.hora_llegada
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
    const existe = await pool.query(
      `
      SELECT id_asistencia FROM asistencia
      WHERE id_dirigente = $1 AND fecha = $2
      `,
      [id_dirigente, fecha]
    );

    if (existe.rows.length > 0) {
      // 🔁 Update
      await pool.query(
        `
        UPDATE asistencia
        SET estado = $1
        WHERE id_dirigente = $2 AND fecha = $3
        `,
        [estado, id_dirigente, fecha]
      );
    } else {
      // ➕ Insert
      await pool.query(
        `
        INSERT INTO asistencia
        (id_dirigente, fecha, hora_llegada, estado, metodo_registro)
        VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::time, $3, 'Manual')
        `,
        [id_dirigente, fecha, estado]
      );
    }

    res.json({ mensaje: 'Asistencia actualizada' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar asistencia' });
  }
});


// Multas
app.get('/multas', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT 
        m.id_multa,
        m.fecha,
        m.monto,
        m.motivo,
        m.detalle,
        m.id_dirigente,
        d.nombre,
        d.apellido
      FROM multa m
      JOIN dirigente d ON m.id_dirigente = d.id_dirigente
      ORDER BY m.fecha DESC
      `
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener multas' });
  }
});

// Obtener multas de un dirigente específico
app.get('/multas/dirigente/:id', auth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
        id_multa,
        fecha,
        monto,
        motivo,
        detalle,
        id_dirigente
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
      `INSERT INTO multa
       (id_dirigente, detalle, monto, motivo)
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

// Delete multa
app.delete('/multa/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM multa
        WHERE id_multa = $1
        RETURNING *`,
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

//Exoditos
app.get('/exoditos', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT 
        e.id_exodito,
        e.nombre,
        e.apellido,
        e.cargo,
        e.id_tribu,
        t.nombre AS tribu
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
      `
      SELECT *
      FROM exodito
      WHERE id_tribu = $1
      ORDER BY nombre
      `,
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
      `
      INSERT INTO exodito (nombre, apellido, cargo, id_tribu)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
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
      `DELETE FROM exodito
        WHERE id_exodito = $1
        RETURNING *`,
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

//Asistencia Exoditos
app.get('/asistencia/exoditos/:fecha', auth, async (req, res) => {
  const { fecha } = req.params;

  try {
    const result = await pool.query(`
      SELECT
        t.nombre AS tribu,
        e.id_exodito,
        e.nombre,
        e.apellido,
        e.cargo,
        ae.estado
      FROM exodito e
      JOIN tribu t ON t.id_tribu = e.id_tribu
      LEFT JOIN asistencia_exodito ae
        ON ae.id_exodito = e.id_exodito
        AND ae.fecha = $1
      ORDER BY t.id_tribu ASC, e.nombre ASC
    `, [fecha]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener asistencia' });
  }
});

app.post('/asistencia/exoditos', auth, async (req, res) => {
  const { id_exodito, fecha, estado } = req.body;

  if (!id_exodito || !fecha || !estado) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const existe = await pool.query(
      `
      SELECT 1
      FROM asistencia_exodito
      WHERE id_exodito = $1 AND fecha = $2
      `,
      [id_exodito, fecha]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Asistencia ya registrada' });
    }

    const result = await pool.query(
      `
      INSERT INTO asistencia_exodito (id_exodito, fecha, estado)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [id_exodito, fecha, estado]
    );

    res.json({
      mensaje: 'Asistencia registrada',
      asistencia: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al registrar asistencia' });
  }
});
/* Eliminar TODA la asistencia de exoditos */
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

/* Eliminar TODA la asistencia de dirigentes */
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

/* ===============================
   Push Tokens
=============================== */

/* Guardar push token del dirigente */
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
    console.error('❌ Error guardando push token:', err);
    res.status(500).json({ error: 'Error al guardar push token' });
  }
});

/* Guardar suscripción de Web Push del dirigente (versión web) */
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
    console.error('❌ Error guardando suscripción web:', err);
    res.status(500).json({ error: 'Error al guardar suscripción' });
  }
});

/* Enviar notificación de recordatorio a todos los dirigentes */
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

    /* ---- Móvil (Expo) ---- */
    if (expoTokens.length > 0) {
      // Construir mensajes para Expo Push API (máx 100 por request)
      const messages = expoTokens.map(token => ({
        to: token,
        sound: 'default',
        title: 'Recordatorio de Asistencia',
        body: 'RECUERDA TOMAR LA ASISTENCIA DE LA TRIBU',
        data: { tipo: 'recordatorio_tribu' },
      }));

      // Enviar en lotes de 100 (límite de Expo)
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

    /* ---- Web (navegador) ---- */
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
          // 404/410 = la suscripción ya no existe (usuario revocó el permiso, cambió de navegador, etc.)
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
    console.error('❌ Error enviando notificaciones:', err);
    res.status(500).json({ error: 'Error al enviar notificaciones' });
  }
});

/* Railway */
app.listen(PORT, '0.0.0.0', () => {
  console.log(' Servidor escuchando en puerto', PORT);
});