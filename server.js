require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

process.on('uncaughtException', err => {
  console.error('❌ UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', err => {
  console.error('❌ UNHANDLED REJECTION:', err);
});


app.get('/', (req, res) => {
  res.send('🚀 Backend Dirigentes funcionando');
});

app.listen(PORT, () => {
  console.log(`🔥 Servidor corriendo en puerto ${PORT}`);
});

app.post('/login', async (req, res) => {
  const { usuario, contrasena } = req.body;

  if (!usuario || !contrasena) {
    return res.status(400).json({ message: 'Faltan datos' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM dirigentes WHERE usuario = $1 AND contrasena = $2',
      [usuario, contrasena]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Usuario o contrasena incorrectos' });
    }

    const user = result.rows[0];

    res.json({
      message: 'Login correcto',
      user: {
        id: user.id,
        nombre: user.nombre,
        usuario: user.usuario,
      },
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});