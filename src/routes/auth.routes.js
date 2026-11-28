import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db/db.js';
import loginLimiter from '../middlewares/rateLimiter.js';

const router = Router();

/* POST /login */
router.post('/login', loginLimiter, async (req, res) => {
  const { usuario, contrasena } = req.body;
  if (!usuario || !contrasena) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  try {
    const result = await pool.query(
      `SELECT d.*, t.nombre AS nombre_tribu, t.drive AS tribu_drive
       FROM dirigente d
       LEFT JOIN tribu t ON t.id_tribu = d.id_tribu
       WHERE d.usuario = $1`,
      [usuario.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const dirigente = result.rows[0];

    const valido = await bcrypt.compare(contrasena.trim(), dirigente.contrasena);
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
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error en login' });
  }
});

export default router;
