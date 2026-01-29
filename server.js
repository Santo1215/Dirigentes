import 'dotenv/config';
import path from 'path';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import pool from './db.js';
import auth from './auth.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.use(
  '/uploads',
  express.static(path.join(process.cwd(), 'uploads'))
);

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
      'SELECT * FROM dirigente WHERE usuario = $1',
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
        codigo: dirigente.codigo
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
        codigo: dirigente.codigo
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
        apellido,
        rol,
        comite,
        id_tribu
      FROM dirigente
      ORDER BY nombre ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Error obteniendo dirigentes:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/*  Actualizar rol y comité de un dirigente */
app.put('/dirigente/:id', async (req, res) => {
  const { id } = req.params;
  const { rol, comite, id_tribu} = req.body;

  if (!rol) {
    return res.status(400).json({ message: 'El rol es obligatorio' });
  }

  try {
    const result = await pool.query(
      `
      UPDATE dirigente
      SET rol = $1, comite = $2, id_tribu = $3
      WHERE id_dirigente = $4
      RETURNING id_dirigente, nombre, apellido, rol, comite
      `,
      [rol, comite || null, id_tribu || null, id]
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

  try {
    const result = await pool.query(
      'DELETE FROM dirigente WHERE id_dirigente = $1 RETURNING nombre, apellido',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Dirigente no encontrado' });
    }

    res.json({
      message: 'Dirigente eliminado',
      dirigente: result.rows[0],
    });
  } catch (error) {
    console.error('❌ Error eliminando dirigente:', error);
    res.status(500).json({ message: 'Error del servidor' });
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
      'SELECT id_tribu, nombre, puntos, color_hex FROM tribu ORDER BY id_tribu'
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
  const { asistencias } = req.body;

  if (!Array.isArray(asistencias) || asistencias.length === 0) {
    return res.status(400).json({ error: 'No hay asistencias para registrar' });
  }

  try {
    const queries = asistencias.map(({ id_exodito, estado }) =>
      pool.query(
        `
        INSERT INTO asistencia_exodito (id_exodito, fecha, estado)
        VALUES ($1, CURRENT_DATE, $2)
        ON CONFLICT (id_exodito, fecha) DO UPDATE
        SET estado = EXCLUDED.estado
        `,
        [id_exodito, estado]
      )
    );

    await Promise.all(queries);

    res.json({
      message: 'Asistencia de exoditos registrada correctamente',
      total: asistencias.length,
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
       VALUES ($1, CURRENT_DATE, CURRENT_TIME, 'Presente', 'QR')
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
       VALUES ($1, CURRENT_TIME, 'Presente', 'Manual')
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
        VALUES ($1, $2, CURRENT_TIME, $3, 'Manual')
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
      SELECT *
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
  const { id_dirigente, id_asistencia, monto, motivo } = req.body;

  if (!id_dirigente || !monto || !motivo) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO multa
       (id_dirigente, id_asistencia, monto, motivo)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id_dirigente, id_asistencia || null, monto, motivo]
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
        ae.estado
      FROM exodito e
      JOIN tribu t ON t.id_tribu = e.id_tribu
      LEFT JOIN asistencia_exodito ae
        ON ae.id_exodito = e.id_exodito
        AND ae.fecha = $1
      ORDER BY t.nombre, e.nombre
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
/* Railway */
app.listen(PORT, '0.0.0.0', () => {
  console.log('🔥 Servidor escuchando en puerto', PORT);
});
