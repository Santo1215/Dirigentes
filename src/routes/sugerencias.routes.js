import { Router } from 'express';
import pool from '../db/db.js';

const router = Router();

/* GET /sugerencias-puntos/usuario/:id_dirigente */
router.get('/sugerencias-puntos/usuario/:id_dirigente', async (req, res) => {
  const { id_dirigente } = req.params;
  try {
    const result = await pool.query(
      `SELECT sp.*, d.nombre as dirigente_nombre, d.apellido as dirigente_apellido
       FROM sugerencias_puntos sp
       JOIN dirigente d ON d.id_dirigente = sp.id_dirigente
       WHERE sp.id_dirigente = $1
       ORDER BY sp.creado_en DESC`,
      [id_dirigente]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo sugerencias de usuario:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* POST /sugerencias-puntos */
router.post('/sugerencias-puntos', async (req, res) => {
  const { id_dirigente, id_tribu, tipo_accion, puntos, descripcion } = req.body;
  
  if (!id_dirigente || !id_tribu || !tipo_accion || !descripcion) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pendiente = await client.query(
      `SELECT id FROM sugerencias_puntos WHERE id_dirigente = $1 AND estado = 'Pendiente'`,
      [id_dirigente]
    );
    if (pendiente.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ya tienes una sugerencia pendiente.' });
    }

    const result = await client.query(
      `INSERT INTO sugerencias_puntos (id_dirigente, tipo_accion, puntos, descripcion)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [id_dirigente, tipo_accion, tipo_accion === 'sumar' ? puntos : null, descripcion]
    );
    
    const idSugerencia = result.rows[0].id;
    const tribusArray = id_tribu.split(',').filter(id => id.trim() !== '');
    
    for (const tribuId of tribusArray) {
      await client.query(
        `INSERT INTO sugerencia_tribus (id_sugerencia, id_tribu) VALUES ($1, $2)`,
        [idSugerencia, tribuId]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Sugerencia creada con éxito' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creando sugerencia:', err);
    res.status(500).json({ error: 'Error al crear sugerencia' });
  } finally {
    client.release();
  }
});

/* GET /sugerencias-puntos/pendientes */
router.get('/sugerencias-puntos/pendientes', async (req, res) => {
  const { id_votante } = req.query;
  try {
    const result = await pool.query(`
      SELECT sp.*, 
             d.nombre as dirigente_nombre, 
             d.apellido as dirigente_apellido,
             (SELECT string_agg(st.id_tribu::text, ',') 
              FROM sugerencia_tribus st 
              WHERE st.id_sugerencia = sp.id) as id_tribu,
             (SELECT string_agg(t.nombre, ', ') 
              FROM sugerencia_tribus st 
              JOIN tribu t ON t.id_tribu = st.id_tribu
              WHERE st.id_sugerencia = sp.id) as tribus_nombres,
             (SELECT COUNT(*) FROM sugerencia_votos sv WHERE sv.id_sugerencia = sp.id) as votos_emitidos,
             (SELECT COUNT(*) FROM dirigente WHERE comite = 'Puntos') as total_comite,
             (SELECT voto FROM sugerencia_votos sv 
              WHERE sv.id_sugerencia = sp.id AND sv.id_dirigente = $1
              LIMIT 1) as mi_voto
      FROM sugerencias_puntos sp
      JOIN dirigente d ON d.id_dirigente = sp.id_dirigente
      WHERE sp.estado = 'Pendiente'
      ORDER BY sp.creado_en ASC
    `, [id_votante || 0]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo sugerencias pendientes:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* POST /sugerencias-puntos/:id/votar */
router.post('/sugerencias-puntos/:id/votar', async (req, res) => {
  const { id } = req.params;
  const { id_dirigente, voto, justificacion } = req.body;

  if (!id_dirigente || !voto) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }
  if (voto === 'Rechazada' && !justificacion) {
    return res.status(400).json({ error: 'Se requiere justificación para rechazar' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO sugerencia_votos (id_sugerencia, id_dirigente, voto, justificacion)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id_sugerencia, id_dirigente) 
       DO UPDATE SET voto = $3, justificacion = $4, creado_en = CURRENT_TIMESTAMP`,
      [id, id_dirigente, voto, justificacion || null]
    );

    if (voto === 'Rechazada') {
      await client.query(
        `UPDATE sugerencias_puntos 
         SET estado = 'Rechazada', justificacion = $1, actualizado_en = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [justificacion, id]
      );
      await client.query('COMMIT');
      return res.json({ message: 'Sugerencia rechazada.', resultado: 'Rechazada' });
    }

    const votosRes = await client.query(
      `SELECT COUNT(*) as aprobaciones FROM sugerencia_votos WHERE id_sugerencia = $1 AND voto = 'Aprobada'`,
      [id]
    );
    const totalComiteRes = await client.query(
      `SELECT COUNT(*) as total FROM dirigente WHERE comite = 'Puntos'`
    );

    const aprobaciones = parseInt(votosRes.rows[0].aprobaciones);
    const totalComite = parseInt(totalComiteRes.rows[0].total);

    if (aprobaciones >= totalComite) {
      const sugRes = await client.query(
        `UPDATE sugerencias_puntos 
         SET estado = 'Aprobada', actualizado_en = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [id]
      );
      const sugerencia = sugRes.rows[0];

      if (sugerencia.tipo_accion === 'sumar' && sugerencia.puntos) {
        const tribusRes = await client.query(
          `SELECT id_tribu FROM sugerencia_tribus WHERE id_sugerencia = $1`, [id]
        );
        for (const t of tribusRes.rows) {
          await client.query(
            `UPDATE tribu SET puntos = puntos + $1 WHERE id_tribu = $2`,
            [sugerencia.puntos, t.id_tribu]
          );
        }
      }

      await client.query('COMMIT');
      return res.json({ message: 'Sugerencia aprobada por unanimidad.', resultado: 'Aprobada' });
    }

    await client.query('COMMIT');
    res.json({ 
      message: `Voto registrado. ${aprobaciones}/${totalComite} aprobaciones.`,
      resultado: 'Pendiente',
      aprobaciones,
      totalComite
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error procesando voto de sugerencia:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

export default router;
