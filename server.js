require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const crypto = require('crypto');

function generarCodigoQR(dirigente) {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `DIR-${dirigente.id_dirigente}-${dirigente.usuario}-${random}`;
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ✅ Health */
app.get('/', (req, res) => {
  res.send('🚀 Backend Dirigentes con DB funcionando');
});

/* ✅ Login */
app.post('/login', async (req, res) => {
  const { usuario, contrasena } = req.body;

  if (!usuario || !contrasena) {
    return res.status(400).json({ message: 'Faltan datos' });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        d.id_dirigente,
        d.usuario,
        d.nombre,
        d.apellido,
        d.rol,
        d.comite,
        t.id_tribu,
        t.nombre AS tribu,
        t.color_hex,
        t.puntos
      FROM dirigente d
      LEFT JOIN tribu t ON d.id_tribu = t.id_tribu
      WHERE d.usuario = $1
        AND d.contrasena = $2
      `,
      [usuario, contrasena]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Usuario o contraseña incorrectos' });
    }

    res.json({
      message: 'Login correcto',
      user: result.rows[0],
    });

  } catch (error) {
    console.error('❌ Error en login:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.post('/dirigente', async (req, res) => {
  const {
    nombre,
    apellido,
    rol,
    comite,
    id_tribu,
    contrasena
  } = req.body;

  // 🔒 Validación mínima
  if (!nombre || !apellido || !rol || !contrasena) {
    return res.status(400).json({ message: 'Faltan datos obligatorios' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    /* 1️⃣ Crear dirigente SIN usuario */
    const dirigenteResult = await client.query(
      `
      INSERT INTO dirigente
      (nombre, apellido, rol, comite, id_tribu, contrasena)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [nombre, apellido, rol, comite, id_tribu, contrasena]
    );

    const dirigente = dirigenteResult.rows[0];

    /* 2️⃣ Generar usuario automático: NombreApellidoID */
    const usuarioGenerado =
      nombre.replace(/\s+/g, '') +
      apellido.replace(/\s+/g, '') +
      dirigente.id_dirigente;

    /* 3️⃣ Actualizar dirigente con el usuario */
    await client.query(
      `
      UPDATE dirigente
      SET usuario = $1
      WHERE id_dirigente = $2
      `,
      [usuarioGenerado, dirigente.id_dirigente]
    );

    /* 4️⃣ Generar QR personal */
    const codigoQR = `DIR-${usuarioGenerado}-${Date.now()}`;
    const tokenSecreto = crypto.randomBytes(16).toString('hex');

    /* 5️⃣ Guardar QR */
    await client.query(
      `
      INSERT INTO qr_personal
      (id_dirigente, codigo_qr, token_secreto)
      VALUES ($1,$2,$3)
      `,
      [dirigente.id_dirigente, codigoQR, tokenSecreto]
    );

    await client.query('COMMIT');

    /* 6️⃣ Respuesta limpia */
    res.status(201).json({
      message: 'Dirigente creado correctamente',
      dirigente: {
        id_dirigente: dirigente.id_dirigente,
        nombre: dirigente.nombre,
        apellido: dirigente.apellido,
        usuario: usuarioGenerado,
        rol: dirigente.rol,
        comite: dirigente.comite,
        id_tribu: dirigente.id_tribu,
        codigo_qr: codigoQR
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error creando dirigente:', error);
    res.status(500).json({ message: 'Error del servidor' });
  } finally {
    client.release();
  }
});


/* ✅ Railway */
app.listen(PORT, '0.0.0.0', () => {
  console.log('🔥 Servidor escuchando en puerto', PORT);
});
