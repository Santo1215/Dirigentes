import { Router } from 'express';
import pool from '../db/db.js';
import { auth } from '../middlewares/auth.js';

const router = Router();

/* GET /materiales */
router.get('/materiales', async (req, res) => {
  try {
    const query = `
      SELECT 
        m.id_material, m.nombre_material, m.cantidad, m.id_dirigente,
        CONCAT(d.nombre, ' ', d.apellido) AS responsable,
        CASE 
          WHEN d.foto IS NOT NULL AND d.foto != '' 
          THEN CONCAT('${req.protocol}://${req.get('host')}/uploads/', d.foto)
          ELSE NULL 
        END AS foto
      FROM materiales m
      LEFT JOIN dirigente d ON m.id_dirigente = d.id_dirigente
      ORDER BY m.nombre_material ASC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al consultar materiales:', error);
    res.status(500).json({ error: 'Error al obtener el inventario de materiales' });
  }
});

/* GET /materiales/todos */
router.get('/materiales/todos', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id_material, nombre_material, cantidad, id_dirigente
      FROM materiales
      ORDER BY nombre_material ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al consultar materiales:', error);
    res.status(500).json({ error: 'Error al obtener materiales' });
  }
});

/* POST /materiales */
router.post('/materiales', auth, async (req, res) => {
  const { nombre_material, cantidad, id_dirigente } = req.body;

  if (!nombre_material || cantidad === undefined || isNaN(parseInt(cantidad))) {
    return res.status(400).json({ error: 'El nombre del material y una cantidad válida son obligatorios' });
  }

  const dirigenteId = (id_dirigente && !isNaN(parseInt(id_dirigente))) ? parseInt(id_dirigente) : null;

  try {
    const query = `
      INSERT INTO materiales (nombre_material, cantidad, id_dirigente)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    const values = [nombre_material.trim(), parseInt(cantidad), dirigenteId];
    const result = await pool.query(query, values);

    res.status(201).json({
      mensaje: 'Material registrado exitosamente',
      material: result.rows[0]
    });
  } catch (error) {
    console.error('Error al insertar material:', error);
    res.status(500).json({ error: 'Error al guardar el material' });
  }
});

/* PUT /materiales/:id */
router.put('/materiales/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { nombre_material, cantidad, id_dirigente } = req.body;

  try {
    const dirigenteId = (id_dirigente && !isNaN(parseInt(id_dirigente))) ? parseInt(id_dirigente) : null;

    const query = `
      UPDATE materiales
      SET nombre_material = COALESCE($1, nombre_material),
          cantidad = COALESCE($2, cantidad),
          id_dirigente = COALESCE($3, id_dirigente)
      WHERE id_material = $4
      RETURNING *
    `;
    const values = [
      nombre_material ? nombre_material.trim() : null,
      cantidad !== undefined && !isNaN(parseInt(cantidad)) ? parseInt(cantidad) : null,
      dirigenteId,
      id
    ];
    
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }

    res.json({
      mensaje: 'Material actualizado correctamente',
      material: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar material:', error);
    res.status(500).json({ error: 'Error al actualizar el material' });
  }
});

/* DELETE /materiales/:id */
router.delete('/materiales/:id', auth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM materiales WHERE id_material = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }

    res.json({ mensaje: 'Material eliminado del inventario' });
  } catch (error) {
    console.error('Error al eliminar material:', error);
    res.status(500).json({ error: 'Error al eliminar el material' });
  }
});

export default router;
