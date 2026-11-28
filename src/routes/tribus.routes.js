import { Router } from 'express';
import pool from '../db/db.js';
import { auth, requerirRol } from '../middlewares/auth.js';

const router = Router();

/* GET /tribus */
router.get('/tribus', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id_tribu, nombre, puntos, color_hex, drive FROM tribu ORDER BY id_tribu'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo tribus:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/* POST /tribu/puntos */
router.post('/tribu/puntos', auth, async (req, res) => {
  const rol = (req.user?.rol || '').trim().toLowerCase();
  const comite = (req.user?.comite || '').trim().toLowerCase();
  const esCoordOAdmin = ['coordinacion', 'coordinación', 'admin'].some(r => rol.includes(r));
  const esComitePuntos = comite.includes('puntos');

  if (!esCoordOAdmin && !esComitePuntos) {
    return res.status(403).json({ error: 'Acceso denegado: solo el comité de Puntos o Coordinación pueden modificar puntos' });
  }

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
    console.error('Error actualizando puntos:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/* POST /tribu — Crear nueva tribu */
router.post('/tribu', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const { nombre, color_hex, drive } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre de la tribu es obligatorio' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO tribu (nombre, puntos, color_hex, drive) VALUES ($1, 0, $2, $3) RETURNING *`,
      [nombre.trim(), color_hex || '#FF8C42', drive || null]
    );
    res.status(201).json({ mensaje: 'Tribu creada', tribu: result.rows[0] });
  } catch (err) {
    console.error('Error creando tribu:', err);
    res.status(500).json({ error: 'Error al crear tribu' });
  }
});

/* PUT /tribu/:id — Actualizar tribu */
router.put('/tribu/:id', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { nombre, color_hex, drive } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre de la tribu es obligatorio' });
  }
  try {
    const result = await pool.query(
      `UPDATE tribu SET nombre = $1, color_hex = $2, drive = $3 WHERE id_tribu = $4 RETURNING *`,
      [nombre.trim(), color_hex || '#FF8C42', drive || null, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tribu no encontrada' });
    res.json({ mensaje: 'Tribu actualizada', tribu: result.rows[0] });
  } catch (err) {
    console.error('Error actualizando tribu:', err);
    res.status(500).json({ error: 'Error al actualizar tribu' });
  }
});

/* DELETE /tribu/:id — Eliminar tribu */
router.delete('/tribu/:id', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE dirigente SET id_tribu = NULL WHERE id_tribu = $1`, [id]);
    await client.query(`UPDATE dirigente SET id_tribu_secundaria = NULL WHERE id_tribu_secundaria = $1`, [id]);
    await client.query(`DELETE FROM asistencia_exodito WHERE id_exodito IN (SELECT id_exodito FROM exodito WHERE id_tribu = $1)`, [id]);
    await client.query(`DELETE FROM exodito WHERE id_tribu = $1`, [id]);
    await client.query(`DELETE FROM sugerencia_tribus WHERE id_tribu = $1`, [id]);
    const result = await client.query(`DELETE FROM tribu WHERE id_tribu = $1 RETURNING *`, [id]);
    await client.query('COMMIT');
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tribu no encontrada' });
    res.json({ mensaje: 'Tribu eliminada', tribu: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error eliminando tribu:', err);
    res.status(500).json({ error: 'Error al eliminar tribu' });
  } finally {
    client.release();
  }
});

export default router;
