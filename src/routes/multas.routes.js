import { Router } from 'express';
import pool from '../db/db.js';
import { auth } from '../middlewares/auth.js';

const router = Router();

/* GET /multas */
router.get('/multas', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id_multa, m.fecha, m.monto, m.motivo, m.detalle, m.id_dirigente, d.nombre, d.apellido, d.comite 
       FROM multa m 
       JOIN dirigente d ON m.id_dirigente = d.id_dirigente 
       WHERE LOWER(COALESCE(d.rol, '')) <> 'asesoría'
       ORDER BY m.fecha DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener multas:', err);
    res.status(500).json({ error: 'Error al obtener multas' });
  }
});

/* GET /multas/dirigente/:id */
router.get('/multas/dirigente/:id', auth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id_multa, fecha, monto, motivo, detalle, id_dirigente
       FROM multa
       WHERE id_dirigente = $1
         AND id_dirigente IN (
           SELECT id_dirigente FROM dirigente WHERE LOWER(COALESCE(rol, '')) <> 'asesoría'
         )
       ORDER BY fecha DESC`,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener multas del dirigente:', err);
    res.status(500).json({ error: 'Error al obtener multas del dirigente' });
  }
});

/* POST /multas */
router.post('/multas', auth, async (req, res) => {
  const { id_dirigente, Detalle, monto, motivo } = req.body;

  if (!id_dirigente || !monto || !motivo) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const idAutor = req.user.id_dirigente;
    const checkRes = await pool.query(
      `SELECT d.rol, d.comite, COALESCE(c.puede_poner_multas, false) AS puede_poner_multas
       FROM dirigente d
       LEFT JOIN comite c ON LOWER(c.nombre) = LOWER(d.comite)
       WHERE d.id_dirigente = $1`,
      [idAutor]
    );
    const autor = checkRes.rows[0];
    const puedePoner = autor && (autor.rol === 'Coordinación' || autor.rol === 'ADMIN' || autor.puede_poner_multas);

    if (!puedePoner) {
      return res.status(403).json({ error: 'Tu comité no tiene permisos para asignar multas' });
    }

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
    console.error('Error al registrar multa:', err);
    res.status(500).json({ error: 'Error al registrar multa' });
  }
});

/* DELETE /multa/:id */
router.delete('/multa/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const idAutor = req.user.id_dirigente;
    const checkRes = await pool.query(
      `SELECT d.rol, d.comite, COALESCE(c.puede_poner_multas, false) AS puede_poner_multas
       FROM dirigente d
       LEFT JOIN comite c ON LOWER(c.nombre) = LOWER(d.comite)
       WHERE d.id_dirigente = $1`,
      [idAutor]
    );
    const autor = checkRes.rows[0];
    const puedeEliminar = autor && (autor.rol === 'Coordinación' || autor.rol === 'ADMIN' || autor.puede_poner_multas);

    if (!puedeEliminar) {
      return res.status(403).json({ error: 'No tienes permisos para eliminar multas' });
    }

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
    console.error('Error al eliminar multa:', err);
    res.status(500).json({ error: 'Error al eliminar multa' });
  }
});

export default router;
