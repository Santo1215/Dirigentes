import { Router } from 'express';
import pool from '../db/db.js';
import { auth } from '../middlewares/auth.js';

const router = Router();

/* GET /actividades */
router.get('/actividades', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM actividades ORDER BY fecha ASC');
    res.json(result.rows); 
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las actividades' });
  }
});

/* POST /actividades */
router.post('/actividades', auth, async (req, res) => {
  const { titulo, descripcion, fecha, responsable, tipo, verificar_asistencia } = req.body;

  if (!titulo || !fecha) {
    return res.status(400).json({ error: 'Faltan datos obligatorios: titulo y fecha' });
  }

  try {
    const idAutor = req.user.id_dirigente;
    const dirRes = await pool.query(
      `SELECT d.rol, d.comite, COALESCE(c.puede_crear_actividades, false) AS puede_crear_actividades
       FROM dirigente d
       LEFT JOIN comite c ON LOWER(c.nombre) = LOWER(d.comite)
       WHERE d.id_dirigente = $1`,
      [idAutor]
    );
    const autor = dirRes.rows[0];
    const esCoord = autor && (autor.rol === 'Coordinación' || autor.rol === 'ADMIN');

    if (!esCoord && (!autor || !autor.puede_crear_actividades)) {
      return res.status(403).json({ error: 'Tu comité no tiene permisos para crear actividades' });
    }

    if (!esCoord) {
      const tipoNorm = (tipo || 'Otro').trim().toLowerCase();
      const comiteNorm = (autor.comite || '').trim().toLowerCase();
      if (tipoNorm !== comiteNorm && tipoNorm !== 'otro') {
        return res.status(403).json({
          error: `Solo puedes crear actividades para tu comité (${autor.comite}) o de tipo "Otro"`
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO actividades (titulo, descripcion, fecha, responsable, tipo, verificar_asistencia)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [titulo, descripcion || null, fecha, responsable || null, tipo || 'Otro', verificar_asistencia === false ? false : true]
    );

    res.status(201).json({
      mensaje: 'Actividad creada correctamente',
      actividad: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la actividad' });
  }
});

/* PUT /actividades/:id */
router.put('/actividades/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { verificar_asistencia, titulo, descripcion, fecha, responsable, tipo } = req.body;

  try {
    const idAutor = req.user.id_dirigente;
    const dirRes = await pool.query(
      `SELECT d.rol, d.comite, d.nombre, d.apellido, COALESCE(c.puede_crear_actividades, false) AS puede_crear_actividades
       FROM dirigente d
       LEFT JOIN comite c ON LOWER(c.nombre) = LOWER(d.comite)
       WHERE d.id_dirigente = $1`,
      [idAutor]
    );
    const autor = dirRes.rows[0];
    const esCoord = autor && (autor.rol === 'Coordinación' || autor.rol === 'ADMIN');

    const actActualRes = await pool.query('SELECT * FROM actividades WHERE id_actividad = $1', [id]);
    if (actActualRes.rows.length === 0) {
      return res.status(404).json({ error: 'Actividad no encontrada' });
    }
    const actActual = actActualRes.rows[0];
    const nombreCompleto = autor ? `${autor.nombre} ${autor.apellido}`.toLowerCase() : '';
    const esResp = actActual.responsable && actActual.responsable.toLowerCase() === nombreCompleto;
    const esMismoComite = autor && autor.comite && actActual.tipo && autor.comite.toLowerCase() === actActual.tipo.toLowerCase();

    if (!esCoord && !esResp && !(autor?.puede_crear_actividades && esMismoComite)) {
      return res.status(403).json({ error: 'No tienes permisos para editar esta actividad' });
    }

    if (!esCoord && tipo) {
      const tipoNorm = tipo.trim().toLowerCase();
      const comiteNorm = (autor.comite || '').trim().toLowerCase();
      if (tipoNorm !== comiteNorm && tipoNorm !== 'otro') {
        return res.status(403).json({
          error: `Solo puedes asignar actividades a tu comité (${autor.comite}) o de tipo "Otro"`
        });
      }
    }

    const result = await pool.query(
      `UPDATE actividades
       SET verificar_asistencia = COALESCE($1, verificar_asistencia),
           titulo = COALESCE($2, titulo),
           descripcion = COALESCE($3, descripcion),
           fecha = COALESCE($4, fecha),
           responsable = COALESCE($5, responsable),
           tipo = COALESCE($6, tipo)
       WHERE id_actividad = $7
       RETURNING *`,
      [
        verificar_asistencia === undefined ? null : verificar_asistencia,
        titulo || null,
        descripcion || null,
        fecha || null,
        responsable || null,
        tipo || null,
        id
      ]
    );

    res.json({
      mensaje: 'Actividad actualizada correctamente',
      actividad: result.rows[0]
    });
  } catch (err) {
    console.error('Error actualizando actividad:', err);
    res.status(500).json({ error: 'Error al actualizar la actividad' });
  }
});

/* DELETE /actividades/:id */
router.delete('/actividades/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const idAutor = req.user.id_dirigente;
    const dirRes = await pool.query(
      `SELECT d.rol, d.comite, d.nombre, d.apellido, COALESCE(c.puede_crear_actividades, false) AS puede_crear_actividades
       FROM dirigente d
       LEFT JOIN comite c ON LOWER(c.nombre) = LOWER(d.comite)
       WHERE d.id_dirigente = $1`,
      [idAutor]
    );
    const autor = dirRes.rows[0];
    const esCoord = autor && (autor.rol === 'Coordinación' || autor.rol === 'ADMIN');

    const actActualRes = await pool.query('SELECT * FROM actividades WHERE id_actividad = $1', [id]);
    if (actActualRes.rows.length === 0) {
      return res.status(404).json({ error: 'Actividad no encontrada' });
    }
    const actActual = actActualRes.rows[0];
    const nombreCompleto = autor ? `${autor.nombre} ${autor.apellido}`.toLowerCase() : '';
    const esResp = actActual.responsable && actActual.responsable.toLowerCase() === nombreCompleto;
    const esMismoComite = autor && autor.comite && actActual.tipo && autor.comite.toLowerCase() === actActual.tipo.toLowerCase();

    if (!esCoord && !esResp && !(autor?.puede_crear_actividades && esMismoComite)) {
      return res.status(403).json({ error: 'No tienes permisos para eliminar esta actividad' });
    }

    await pool.query('DELETE FROM asistencia_actividad WHERE id_actividad = $1', [id]);
    const result = await pool.query(
      `DELETE FROM actividades WHERE id_actividad = $1 RETURNING *`,
      [id]
    );
    res.json({ mensaje: 'Actividad eliminada', actividad: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar la actividad' });
  }
});

/* POST /actividades/:id/confirmar */
router.post('/actividades/:id/confirmar', async (req, res) => {
  const { id } = req.params;
  const { id_dirigente, estado } = req.body; 

  if (!id_dirigente) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const dirigenteCheck = await pool.query(
      'SELECT rol FROM dirigente WHERE id_dirigente = $1',
      [id_dirigente]
    );

    if (dirigenteCheck.rows.length > 0 && ['asesoría', 'asesoria'].includes((dirigenteCheck.rows[0].rol || '').toLowerCase())) {
      return res.status(400).json({ error: 'No se puede registrar asistencia para asesores' });
    }

    const query = `
      INSERT INTO asistencia_actividad (id_actividad, id_dirigente, estado)
      VALUES ($1, $2, $3)
      ON CONFLICT (id_actividad, id_dirigente) 
      DO UPDATE SET estado = EXCLUDED.estado;
    `;
    
    await pool.query(query, [id, id_dirigente, estado]);
    res.json({ message: 'Asistencia registrada correctamente' });
  } catch (error) {
    console.error('Error guardando asistencia:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* GET /actividades/:id/asistentes */
router.get('/actividades/:id/asistentes', async (req, res) => {
  const { id } = req.params;
  try {
    const query = `
      SELECT d.id_dirigente, d.nombre, d.apellido, d.foto, aa.estado
      FROM asistencia_actividad aa
      JOIN dirigente d ON aa.id_dirigente = d.id_dirigente
      WHERE aa.id_actividad = $1
        AND LOWER(COALESCE(d.rol, '')) <> 'asesoría'
    `;
    const result = await pool.query(query, [id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo asistentes:', error);
    res.status(500).json({ error: 'Error al obtener asistentes' });
  }
});

export default router;
