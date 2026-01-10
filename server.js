require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');

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

/* ✅ Railway */
app.listen(PORT, '0.0.0.0', () => {
  console.log('🔥 Servidor escuchando en puerto', PORT);
});
