import { Router } from 'express';
import pool from '../db/db.js';
import { auth } from '../middlewares/auth.js';

const router = Router();

/* GET /asambleas */
router.get('/asambleas', async (req, res) => {
  try {
    const query = `
      SELECT a.*,
             c.nombre AS encargado_nombre, c.apellido AS encargado_apellido,
             p.nombre AS pitar_nombre, p.apellido AS pitar_apellido, p.foto AS pitar_foto,
             t.nombre AS tiempo_nombre, t.apellido AS tiempo_apellido, t.foto AS tiempo_foto
      FROM asamblea a
      LEFT JOIN dirigente c ON a.id_encargado = c.id_dirigente
      LEFT JOIN dirigente p ON a.id_encargado_pitar = p.id_dirigente
      LEFT JOIN dirigente t ON a.id_encargado_tiempo = t.id_dirigente
      ORDER BY a.fecha ASC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener asambleas' });
  }
});

/* POST /asambleas */
router.post('/asambleas', auth, async (req, res) => {
  const { titulo, id_encargado, id_encargado_pitar, id_encargado_tiempo, otros_encargados, materiales, fecha, descripcion } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO asamblea (titulo, id_encargado, id_encargado_pitar, id_encargado_tiempo, otros_encargados, materiales, fecha, descripcion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [titulo, id_encargado, id_encargado_pitar || null, id_encargado_tiempo || null, JSON.stringify(otros_encargados || []), materiales, fecha, descripcion]
    );
    res.status(201).json({ mensaje: 'Asamblea creada', asamblea: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear asamblea' });
  }
});

/* PUT /asambleas/:id */
router.put('/asambleas/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { titulo, id_encargado_pitar, id_encargado_tiempo, otros_encargados, materiales, fecha, descripcion } = req.body;
  try {
    const result = await pool.query(
      `UPDATE asamblea
       SET titulo = COALESCE($1, titulo),
           id_encargado_pitar = COALESCE($2, id_encargado_pitar),
           id_encargado_tiempo = COALESCE($3, id_encargado_tiempo),
           otros_encargados = COALESCE($4, otros_encargados),
           materiales = COALESCE($5, materiales),
           fecha = COALESCE($6, fecha),
           descripcion = COALESCE($7, descripcion)
       WHERE id_asamblea = $8 RETURNING *`,
      [
        titulo || null,
        id_encargado_pitar || null,
        id_encargado_tiempo || null,
        otros_encargados ? JSON.stringify(otros_encargados) : null,
        materiales || null,
        fecha || null,
        descripcion || null,
        id
      ]
    );
    res.json({ mensaje: 'Asamblea actualizada', asamblea: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar asamblea' });
  }
});

/* DELETE /asambleas/:id */
router.delete('/asambleas/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM calificacion_asamblea WHERE id_asamblea = $1', [id]);
    await pool.query('DELETE FROM asamblea WHERE id_asamblea = $1', [id]);
    res.json({ mensaje: 'Asamblea eliminada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar asamblea' });
  }
});

/* GET /asambleas/:id/calificaciones */
router.get('/asambleas/:id/calificaciones', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT
         ca.id_calificacion,
         ca.estrellas,
         ca.resena,
         ca.fecha_registro,
         d.id_dirigente,
         d.nombre,
         d.apellido,
         d.foto
       FROM calificacion_asamblea ca
       JOIN dirigente d ON ca.id_dirigente = d.id_dirigente
       WHERE ca.id_asamblea = $1
         AND LOWER(COALESCE(d.rol, '')) <> 'asesoría'
       ORDER BY ca.fecha_registro DESC`,
      [id]
    );

    const promedio = result.rows.length
      ? (result.rows.reduce((acc, r) => acc + Number(r.estrellas), 0) / result.rows.length).toFixed(1)
      : null;

    res.json({ calificaciones: result.rows, promedio, total: result.rows.length });
  } catch (err) {
    console.error('Error obteniendo calificaciones:', err);
    res.status(500).json({ error: 'Error al obtener calificaciones' });
  }
});

/* GET /asambleas/:id/mi-calificacion */
router.get('/asambleas/:id/mi-calificacion', async (req, res) => {
  const { id } = req.params;
  const { id_dirigente } = req.query;

  if (!id_dirigente) {
    return res.status(400).json({ error: 'Se requiere id_dirigente como query param' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM calificacion_asamblea
       WHERE id_asamblea = $1 AND id_dirigente = $2`,
      [id, id_dirigente]
    );

    if (result.rows.length === 0) {
      return res.json({ calificacion: null });
    }

    res.json({ calificacion: result.rows[0] });
  } catch (err) {
    console.error('Error obteniendo mi calificación:', err);
    res.status(500).json({ error: 'Error al buscar calificación' });
  }
});

/* POST /asambleas/:id/calificaciones */
router.post('/asambleas/:id/calificaciones', async (req, res) => {
  const { id } = req.params;
  const { id_dirigente, estrellas, resena } = req.body;

  if (!id_dirigente) {
    return res.status(400).json({ error: 'id_dirigente es obligatorio' });
  }
  if (!estrellas || estrellas < 0 || estrellas > 5) {
    return res.status(400).json({ error: 'Las estrellas deben ser un valor entre 0 y 5' });
  }
  if (!resena || !resena.trim()) {
    return res.status(400).json({ error: 'La reseña es obligatoria' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO calificacion_asamblea (id_asamblea, id_dirigente, estrellas, resena)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, id_dirigente, estrellas, resena.trim()]
    );

    res.status(201).json({
      mensaje: 'Calificación registrada correctamente',
      calificacion: result.rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ya calificaste esta asamblea anteriormente' });
    }
    console.error('Error guardando calificación:', err);
    res.status(500).json({ error: 'Error al guardar la calificación' });
  }
});

export default router;
