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

app.post('/login', (req, res) => {
  res.json({ message: 'LOGIN OK SIN DB' });
});