import { Router } from 'express';
import pool from '../db/db.js';
import { auth, requerirRol } from '../middlewares/auth.js';

const router = Router();

/* DELETE /admin/limpiar-datos */
router.delete('/admin/limpiar-datos', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r1 = await client.query(`DELETE FROM actividades`);
    const r2 = await client.query(`DELETE FROM calificacion_asamblea`);
    const r3 = await client.query(`DELETE FROM asamblea`);
    const r4 = await client.query(`DELETE FROM asistencia_exodito`);
    const r5 = await client.query(`DELETE FROM asistencia`);
    const r6 = await client.query(`DELETE FROM asistencia_exodito_sinai`);
    const r7 = await client.query(`DELETE FROM sugerencia_votos`);
    const r8 = await client.query(`DELETE FROM sugerencia_tribus`);
    const r9 = await client.query(`DELETE FROM sugerencias_puntos`);

    await client.query('COMMIT');

    res.json({
      mensaje: 'Datos eliminados correctamente',
      eliminados: {
        actividades: r1.rowCount,
        calificaciones_asambleas: r2.rowCount,
        asambleas: r3.rowCount,
        asistencia_exoditos: r4.rowCount,
        asistencia_dirigentes: r5.rowCount,
        asistencia_sinai: r6.rowCount,
        sugerencia_votos: r7.rowCount,
        sugerencia_tribus: r8.rowCount,
        sugerencias_puntos: r9.rowCount,
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en limpiar-datos:', err);
    res.status(500).json({ error: 'Error al limpiar datos' });
  } finally {
    client.release();
  }
});

export default router;
