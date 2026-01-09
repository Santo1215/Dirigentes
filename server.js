require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('BACKEND OK SIN DB');
});

app.post('/login', (req, res) => {
  res.json({ message: 'LOGIN OK SIN DB' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Servidor escuchando en puerto', PORT);
});
