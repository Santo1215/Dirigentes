import { Router } from 'express';
import pool from '../db/db.js';
import { auth, requerirRol } from '../middlewares/auth.js';

const router = Router();

/* POST /asistencia/qr */
router.post('/asistencia/qr', auth, async (req, res) => {
  const { codigo_qr } = req.body;

  if (!codigo_qr) {
    return res.status(400).json({ error: 'Código QR requerido' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const qrResult = await client.query(
      `SELECT *
       FROM qr_personal
       WHERE codigo_qr = $1
       AND fecha_expiracion >= CURRENT_DATE`,
      [codigo_qr]
    );

    if (qrResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'QR inválido o expirado' });
    }

    const qr = qrResult.rows[0];

    const dirigenteInfo = await client.query(
      'SELECT rol FROM dirigente WHERE id_dirigente = $1',
      [qr.id_dirigente]
    );

    if (dirigenteInfo.rows.length > 0 && ['asesoría', 'asesoria'].includes((dirigenteInfo.rows[0].rol || '').toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Los asesores no registran asistencia por QR' });
    }

    const existe = await client.query(
      `SELECT estado
       FROM asistencia
       WHERE id_dirigente = $1
       AND fecha = CURRENT_DATE`,
       [qr.id_dirigente]
    );

    if (existe.rows.length > 0 && existe.rows[0].estado === 'Presente') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Asistencia ya registrada hoy' });
    }

    const asistencia = await client.query(
      `INSERT INTO asistencia
       (id_dirigente, fecha, hora_llegada, estado, metodo_registro)
       VALUES ($1, CURRENT_DATE, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::time, 'Presente', 'QR')
       ON CONFLICT (id_dirigente, fecha) DO UPDATE 
       SET hora_llegada = EXCLUDED.hora_llegada, estado = 'Presente', metodo_registro = 'QR'
       RETURNING *`,
      [qr.id_dirigente]
    );

    await client.query(
      `UPDATE qr_personal
       SET veces_usado = COALESCE(veces_usado, 0) + 1,
           ultimo_uso = CURRENT_TIMESTAMP
       WHERE id_qr = $1`,
      [qr.id_qr]
    );

    await client.query('COMMIT');

    res.json({
      mensaje: 'Asistencia registrada correctamente',
      asistencia: asistencia.rows[0]
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR ASISTENCIA QR:', err);
    res.status(500).json({
      error: 'Error al registrar asistencia'
    });
  } finally {
    client.release();
  }
});

/* POST /asistencia/manual */
router.post('/asistencia/manual', auth, async (req, res) => {
  const { codigo } = req.body;

  if (!codigo) {
    return res.status(400).json({ error: 'Código requerido' });
  }

  try {
    const dirigente = await pool.query(
      `SELECT id_dirigente, rol FROM dirigente WHERE codigo = $1`,
      [codigo]
    );

    if (dirigente.rows.length === 0) {
      return res.status(404).json({ error: 'Código inválido' });
    }

    if (['asesoría', 'asesoria'].includes((dirigente.rows[0].rol || '').toLowerCase())) {
      return res.status(400).json({ error: 'Los asesores no registran asistencia' });
    }

    const id_dirigente = dirigente.rows[0].id_dirigente;

    const existe = await pool.query(
      `SELECT estado FROM asistencia
       WHERE id_dirigente = $1 AND fecha = CURRENT_DATE`,
      [id_dirigente]
    );

    if (existe.rows.length > 0 && existe.rows[0].estado === 'Presente') {
      return res.status(400).json({ error: 'Asistencia ya registrada hoy' });
    }

    const result = await pool.query(
      `INSERT INTO asistencia
       (id_dirigente, fecha, hora_llegada, estado, metodo_registro)
       VALUES ($1, CURRENT_DATE, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::time, 'Presente', 'Manual')
       ON CONFLICT (id_dirigente, fecha) DO UPDATE
       SET hora_llegada = EXCLUDED.hora_llegada, estado = 'Presente', metodo_registro = 'Manual'
       RETURNING *`,
      [id_dirigente]
    );

    res.json({
      mensaje: 'Asistencia registrada',
      asistencia: result.rows[0],
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al registrar asistencia manual' });
  }
});

/* GET /asistencia/fecha/:fecha */
router.get('/asistencia/fecha/:fecha', auth, async (req, res) => {
  const { fecha } = req.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(Date.parse(fecha))) {
    return res.status(400).json({ error: 'Formato de fecha inválido. Se espera YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `
      SELECT 
        d.id_dirigente, d.nombre, d.apellido, d.rol, d.foto,
        a.id_asistencia, a.estado, a.metodo_registro, a.hora_llegada
      FROM dirigente d
      LEFT JOIN asistencia a
        ON d.id_dirigente = a.id_dirigente
        AND a.fecha = $1
      WHERE LOWER(COALESCE(d.rol, '')) <> 'asesoría'
      ORDER BY d.nombre
      `,
      [fecha]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener asistencia' });
  }
});

/* PUT /asistencia */
router.put('/asistencia', auth, async (req, res) => {
  const { id_dirigente, fecha, estado, metodo_registro } = req.body;

  if (!id_dirigente || !fecha || !estado) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const dirigente = await pool.query(
      'SELECT rol FROM dirigente WHERE id_dirigente = $1',
      [id_dirigente]
    );

    if (dirigente.rows.length > 0 && dirigente.rows[0].rol === 'Asesoría') {
      return res.status(400).json({ error: 'No se puede registrar asistencia para asesores' });
    }

    const metodo = metodo_registro || 'Manual';

    await pool.query(
      `INSERT INTO asistencia (id_dirigente, fecha, hora_llegada, estado, metodo_registro)
       VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::time, $3, $4)
       ON CONFLICT (id_dirigente, fecha) 
       DO UPDATE SET 
         estado = EXCLUDED.estado,
         hora_llegada = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::time,
         metodo_registro = EXCLUDED.metodo_registro`,
      [id_dirigente, fecha, estado, metodo]
    );

    res.json({ mensaje: 'Asistencia actualizada correctamente' });
  } catch (err) {
    console.error('Error al registrar asistencia:', err);
    res.status(500).json({ error: 'Error al actualizar asistencia' });
  }
});

/* DELETE /asistencia/dirigentes */
router.delete('/asistencia/dirigentes', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM asistencia`);
    res.json({
      mensaje: 'Asistencia de dirigentes eliminada',
      eliminados: result.rowCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar asistencia de dirigentes' });
  }
});

/* GET /asistencia/reporte-tribus */
router.get('/asistencia/reporte-tribus', auth, async (req, res) => {
  const { desde, hasta } = req.query;

  if (!desde || !hasta) {
    return res.status(400).json({ error: 'Se requieren los parámetros "desde" y "hasta"' });
  }

  try {
    const result = await pool.query(`
      WITH
      fechas_exo AS (
        SELECT DISTINCT fecha FROM asistencia_exodito
        WHERE fecha BETWEEN $1 AND $2
      ),
      presentes_exo AS (
        SELECT e.id_tribu, COUNT(*) AS presentes
        FROM asistencia_exodito ae
        JOIN exodito e ON e.id_exodito = ae.id_exodito
        WHERE ae.fecha BETWEEN $1 AND $2 AND e.id_tribu IS NOT NULL
        GROUP BY e.id_tribu
      ),
      posibles_exo AS (
        SELECT e.id_tribu,
               COUNT(DISTINCT e.id_exodito) * (SELECT COUNT(*) FROM fechas_exo) AS posibles
        FROM exodito e
        WHERE e.id_tribu IS NOT NULL
        GROUP BY e.id_tribu
      )
      SELECT
        t.id_tribu, t.nombre, t.color_hex,
        COALESCE(pe.presentes, 0) AS total_presentes,
        COALESCE(poe.posibles, 0) AS total_posibles,
        CASE
          WHEN COALESCE(poe.posibles, 0) = 0 THEN 0
          ELSE ROUND(COALESCE(pe.presentes, 0)::numeric / poe.posibles * 100, 1)
        END AS porcentaje
      FROM tribu t
      LEFT JOIN presentes_exo pe ON pe.id_tribu = t.id_tribu
      LEFT JOIN posibles_exo poe ON poe.id_tribu = t.id_tribu
      ORDER BY t.id_tribu
    `, [desde, hasta]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar el reporte' });
  }
});

/* GET /asistencia/tribu/:id_tribu */
router.get('/asistencia/tribu/:id_tribu', auth, async (req, res) => {
  const { id_tribu } = req.params;
  const { desde, hasta } = req.query;

  if (!desde || !hasta) {
    return res.status(400).json({ error: 'Se requieren los parámetros "desde" y "hasta"' });
  }

  try {
    const result = await pool.query(`
      WITH
      fechas_exo AS (
        SELECT DISTINCT fecha FROM asistencia_exodito
        WHERE fecha BETWEEN $1 AND $2
      ),
      presentes_exo AS (
        SELECT e.id_tribu, COUNT(*) AS presentes
        FROM asistencia_exodito ae
        JOIN exodito e ON e.id_exodito = ae.id_exodito
        WHERE ae.fecha BETWEEN $1 AND $2
          AND e.id_tribu = $3
          AND ae.estado = 'Presente'
        GROUP BY e.id_tribu
      ),
      posibles_exo AS (
        SELECT e.id_tribu,
               COUNT(DISTINCT e.id_exodito) * (SELECT COUNT(*) FROM fechas_exo) AS posibles
        FROM exodito e
        WHERE e.id_tribu = $3
        GROUP BY e.id_tribu
      )
      SELECT
        t.id_tribu, t.nombre, t.color_hex,
        COALESCE(pe.presentes, 0) AS total_presentes,
        COALESCE(poe.posibles, 0) AS total_posibles,
        CASE
          WHEN COALESCE(poe.posibles, 0) = 0 THEN 0
          ELSE ROUND(COALESCE(pe.presentes, 0)::numeric / poe.posibles * 100, 1)
        END AS porcentaje
      FROM tribu t
      LEFT JOIN presentes_exo pe ON pe.id_tribu = t.id_tribu
      LEFT JOIN posibles_exo poe ON poe.id_tribu = t.id_tribu
      WHERE t.id_tribu = $3
    `, [desde, hasta, id_tribu]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tribu no encontrada' });
    }

    const datos = result.rows[0];

    const exoditosResult = await pool.query(`
      SELECT
        e.id_exodito,
        e.nombre,
        e.apellido,
        e.cargo,
        COUNT(DISTINCT CASE WHEN ae.fecha BETWEEN $1 AND $2 AND ae.estado = 'Presente' THEN ae.fecha END) AS asistencias_rango,
        COUNT(DISTINCT CASE WHEN ae.estado = 'Presente' THEN ae.fecha END) AS total_asistencias
      FROM exodito e
      LEFT JOIN asistencia_exodito ae ON ae.id_exodito = e.id_exodito
      WHERE e.id_tribu = $3
      GROUP BY e.id_exodito, e.nombre, e.apellido, e.cargo
      ORDER BY e.nombre
    `, [desde, hasta, id_tribu]);

    res.json({
      tribu: {
        id_tribu: datos.id_tribu,
        nombre: datos.nombre,
        color_hex: datos.color_hex,
        porcentaje: datos.porcentaje,
        total_presentes: datos.total_presentes,
        total_posibles: datos.total_posibles,
        exoditos: exoditosResult.rows,
      },
      desde,
      hasta,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar el reporte de la tribu' });
  }
});

/* GET /asistencia/tribus/todas */
router.get('/asistencia/tribus/todas', auth, async (req, res) => {
  const { desde, hasta } = req.query;

  if (!desde || !hasta) {
    return res.status(400).json({ error: 'Se requieren los parámetros "desde" y "hasta"' });
  }

  try {
    const result = await pool.query(`
      WITH
      fechas_exo AS (
        SELECT DISTINCT fecha FROM asistencia_exodito
        WHERE fecha BETWEEN $1 AND $2
      ),
      presentes_exo AS (
        SELECT e.id_tribu, COUNT(*) AS presentes
        FROM asistencia_exodito ae
        JOIN exodito e ON e.id_exodito = ae.id_exodito
        WHERE ae.fecha BETWEEN $1 AND $2
          AND ae.estado = 'Presente'
        GROUP BY e.id_tribu
      ),
      posibles_exo AS (
        SELECT e.id_tribu,
               COUNT(DISTINCT e.id_exodito) * (SELECT COUNT(*) FROM fechas_exo) AS posibles
        FROM exodito e
        GROUP BY e.id_tribu
      )
      SELECT
        t.id_tribu, t.nombre, t.color_hex,
        COALESCE(pe.presentes, 0) AS total_presentes,
        COALESCE(po.posibles, 0) AS total_posibles,
        CASE
          WHEN COALESCE(po.posibles, 0) = 0 THEN 0
          ELSE ROUND(COALESCE(pe.presentes, 0)::numeric / COALESCE(po.posibles, 0) * 100, 1)
        END AS porcentaje
      FROM tribu t
      LEFT JOIN presentes_exo pe ON pe.id_tribu = t.id_tribu
      LEFT JOIN posibles_exo po ON po.id_tribu = t.id_tribu
      ORDER BY t.id_tribu
    `, [desde, hasta]);

    const tribusMap = new Map();
    result.rows.forEach(row => {
      if (!tribusMap.has(row.id_tribu)) {
        tribusMap.set(row.id_tribu, {
          id_tribu: row.id_tribu,
          nombre: row.nombre,
          color_hex: row.color_hex,
          exoditos: [],
          porcentaje: parseFloat(row.porcentaje) || 0,
          total_presentes: Number(row.total_presentes) || 0,
          total_posibles: Number(row.total_posibles) || 0
        });
      }
    });

    const exoditosResult = await pool.query(`
      SELECT
        e.id_exodito,
        e.nombre,
        e.apellido,
        e.cargo,
        e.id_tribu,
        COUNT(DISTINCT CASE WHEN ae.fecha BETWEEN $1 AND $2 AND ae.estado = 'Presente' THEN ae.fecha END) AS asistencias_rango,
        COUNT(DISTINCT CASE WHEN ae.estado = 'Presente' THEN ae.fecha END) AS total_asistencias
      FROM exodito e
      LEFT JOIN asistencia_exodito ae ON ae.id_exodito = e.id_exodito
      GROUP BY e.id_exodito, e.nombre, e.apellido, e.cargo, e.id_tribu
      ORDER BY e.id_tribu, e.nombre
    `, [desde, hasta]);

    exoditosResult.rows.forEach(exo => {
      const tribu = tribusMap.get(exo.id_tribu);
      if (tribu) {
        tribu.exoditos.push({
          id_exodito: exo.id_exodito,
          nombre: exo.nombre,
          apellido: exo.apellido,
          cargo: exo.cargo,
          asistencias_rango: Number(exo.asistencias_rango) || 0,
          total_asistencias: Number(exo.total_asistencias) || 0
        });
      }
    });

    res.json({ tribus: Array.from(tribusMap.values()), desde, hasta });
  } catch (err) {
    console.error('Error en tribus/todas:', err);
    res.status(500).json({ error: 'Error al obtener el reporte completo de tribus' });
  }
});

/* GET /asistencia/dirigente/:id/buscar */
router.get('/asistencia/dirigente/:id/buscar', auth, async (req, res) => {
  const { id } = req.params;
  const { desde, hasta } = req.query;

  try {
    const dirigenteResult = await pool.query(
      `SELECT id_dirigente, nombre, apellido, rol, comite FROM dirigente WHERE id_dirigente = $1`,
      [id]
    );

    if (dirigenteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dirigente no encontrado' });
    }

    const dirigente = dirigenteResult.rows[0];

    const totalFechasResult = await pool.query(
      `SELECT COUNT(DISTINCT fecha) AS total FROM asistencia`
    );
    const totalFechas = parseInt(totalFechasResult.rows[0]?.total || 0);

    const asistenciasResult = await pool.query(
      `SELECT DISTINCT fecha, estado, hora_llegada FROM asistencia WHERE id_dirigente = $1 AND estado IN ('Presente', 'Tarde') ORDER BY fecha`,
      [id]
    );
    const totalAsistencias = asistenciasResult.rows.length;
    const porcentajeGlobal = totalFechas > 0 ? Math.round((totalAsistencias / totalFechas) * 100) : 0;

    let rangoPresentes = 0;
    let rangoPosibles = 0;
    let porcentajeRango = 0;
    let registrosRango = [];

    if (desde && hasta) {
      const rangoFechasResult = await pool.query(
        `SELECT COUNT(DISTINCT fecha) AS total FROM asistencia WHERE fecha BETWEEN $1 AND $2`,
        [desde, hasta]
      );
      rangoPosibles = parseInt(rangoFechasResult.rows[0]?.total || 0);

      const rangoPresentesResult = await pool.query(
        `SELECT fecha, estado, hora_llegada FROM asistencia WHERE id_dirigente = $1 AND fecha BETWEEN $2 AND $3 AND estado IN ('Presente', 'Tarde') ORDER BY fecha`,
        [id, desde, hasta]
      );
      rangoPresentes = rangoPresentesResult.rows.length;
      porcentajeRango = rangoPosibles > 0 ? Math.round((rangoPresentes / rangoPosibles) * 100) : 0;
      registrosRango = rangoPresentesResult.rows;
    }

    res.json({
      dirigente,
      total_asistencias: totalAsistencias,
      total_posibles: totalFechas,
      porcentaje_global: porcentajeGlobal,
      porcentaje_rango: porcentajeRango,
      rango_presentes: rangoPresentes,
      rango_posibles: rangoPosibles,
      registros_rango: registrosRango,
      desde: desde || null,
      hasta: hasta || null,
    });
  } catch (err) {
    console.error('Error en buscar dirigente:', err);
    res.status(500).json({ error: 'Error al buscar asistencia del dirigente' });
  }
});

export default router;
