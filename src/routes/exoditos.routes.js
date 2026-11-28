import { Router } from 'express';
import pool from '../db/db.js';
import { auth, requerirRol } from '../middlewares/auth.js';

const router = Router();

/* GET /exoditos */
router.get('/exoditos', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id_exodito, e.nombre, e.apellido, e.cargo, e.id_tribu, t.nombre AS tribu
       FROM exodito e
       JOIN tribu t ON e.id_tribu = t.id_tribu
       ORDER BY e.nombre`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener exoditos:', err);
    res.status(500).json({ error: 'Error al obtener exoditos' });
  }
});

/* GET /exoditos/tribu/:id_tribu */
router.get('/exoditos/tribu/:id_tribu', auth, async (req, res) => {
  const { id_tribu } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM exodito WHERE id_tribu = $1 ORDER BY nombre`,
      [id_tribu]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener exoditos por tribu:', err);
    res.status(500).json({ error: 'Error al obtener exoditos por tribu' });
  }
});

/* GET /exoditos/sinai */
router.get('/exoditos/sinai', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id_exodito, e.nombre, e.apellido, e.cargo, e.id_tribu, t.nombre AS tribu, t.color_hex
       FROM exodito e
       JOIN tribu t ON e.id_tribu = t.id_tribu
       WHERE e.cargo <> 'Exodito'
       ORDER BY t.id_tribu ASC, CASE e.cargo WHEN 'Jefe' THEN 1 WHEN 'Subjefe' THEN 2 WHEN 'Líder' THEN 3 ELSE 4 END`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener exoditos para Sinai:', err);
    res.status(500).json({ error: 'Error al obtener exoditos para Sinai' });
  }
});

/* POST /exoditos */
router.post('/exoditos', auth, async (req, res) => {
  const { nombre, apellido, cargo, id_tribu } = req.body;

  if (!nombre || !apellido || !id_tribu) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO exodito (nombre, apellido, cargo, id_tribu)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [nombre, apellido, cargo || null, id_tribu]
    );

    res.json({
      mensaje: 'Exodito creado correctamente',
      exodito: result.rows[0]
    });
  } catch (err) {
    console.error('Error al crear exodito:', err);
    res.status(500).json({ error: 'Error al crear exodito' });
  }
});

/* PUT /exodito/:id */
router.put('/exodito/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { nombre, apellido, cargo, id_tribu } = req.body;
  if (!nombre || !apellido || !id_tribu) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  try {
    const result = await pool.query(
      `UPDATE exodito
        SET nombre = $1, apellido = $2, cargo = $3, id_tribu = $4
        WHERE id_exodito = $5
        RETURNING *`,
      [nombre, apellido, cargo || null, id_tribu, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Exodito no encontrado' });
    }

    res.json({
      mensaje: 'Exodito actualizado correctamente',
      exodito: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar exodito' });
  }
});

/* DELETE /exodito/:id */
router.delete('/exodito/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM exodito WHERE id_exodito = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Exodito no encontrado' });
    }

    res.json({
      mensaje: 'Exodito eliminado correctamente',
      exodito: result.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar exodito' });
  }
});

/* GET /asistencia/exoditos */
router.get('/asistencia/exoditos', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.nombre AS tribu,
        e.id_exodito,
        e.nombre AS exodito,
        ARRAY_AGG(a.fecha ORDER BY a.fecha) AS fechas
      FROM asistencia_exodito a
      JOIN exodito e ON e.id_exodito = a.id_exodito
      JOIN tribu t ON t.id_tribu = e.id_tribu
      WHERE a.estado = 'Presente'
      GROUP BY t.nombre, e.id_exodito, e.nombre
      ORDER BY t.nombre, e.nombre
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error asistencia exoditos:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/* GET /asistencia/exoditos/:fecha */
router.get('/asistencia/exoditos/:fecha', auth, async (req, res) => {
  const { fecha } = req.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(Date.parse(fecha))) {
    return res.status(400).json({ error: 'Formato de fecha inválido. Se espera YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(`
      SELECT
        t.nombre AS tribu, e.id_exodito, e.nombre, e.apellido, e.cargo, ae.estado
      FROM exodito e
      JOIN tribu t ON t.id_tribu = e.id_tribu
      LEFT JOIN asistencia_exodito ae
        ON ae.id_exodito = e.id_exodito AND ae.fecha = $1
      ORDER BY t.id_tribu ASC, e.nombre ASC
    `, [fecha]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener asistencia' });
  }
});

/* POST /asistencia/exoditos */
router.post('/asistencia/exoditos', auth, async (req, res) => {
  const { asistencias, fecha } = req.body;

  if (!Array.isArray(asistencias) || asistencias.length === 0) {
    return res.status(400).json({ error: 'No hay asistencias para registrar' });
  }

  const fechaRegistro = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)
    ? fecha
    : new Date().toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const { id_exodito, estado } of asistencias) {
      if (estado === 'Presente') {
        await client.query(
          `INSERT INTO asistencia_exodito (id_exodito, fecha, estado)
           VALUES ($1, $2, 'Presente')
           ON CONFLICT (id_exodito, fecha) DO UPDATE SET estado = 'Presente'`,
          [id_exodito, fechaRegistro]
        );
      } else {
        await client.query(
          `DELETE FROM asistencia_exodito WHERE id_exodito = $1 AND fecha = $2`,
          [id_exodito, fechaRegistro]
        );
      }
    }

    await client.query('COMMIT');

    res.json({
      message: 'Asistencia de exoditos registrada correctamente',
      total: asistencias.length,
      fecha: fechaRegistro,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al registrar asistencia de exoditos' });
  } finally {
    client.release();
  }
});

/* DELETE /asistencia/exoditos */
router.delete('/asistencia/exoditos', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM asistencia_exodito`);
    res.json({
      mensaje: 'Asistencia de exoditos eliminada',
      eliminados: result.rowCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar asistencia de exoditos' });
  }
});

/* GET /asistencia/exoditos/sinai/:fecha */
router.get('/asistencia/exoditos/sinai/:fecha', auth, async (req, res) => {
  const { fecha } = req.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(Date.parse(fecha))) {
    return res.status(400).json({ error: 'Formato de fecha inválido. Se espera YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(`
      SELECT
        t.nombre AS tribu, e.id_exodito, e.nombre, e.apellido, e.cargo, ae.estado
      FROM exodito e
      JOIN tribu t ON t.id_tribu = e.id_tribu
      LEFT JOIN asistencia_exodito_sinai ae
        ON ae.id_exodito = e.id_exodito AND ae.fecha = $1
      ORDER BY t.id_tribu ASC, e.nombre ASC
    `, [fecha]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener asistencia Sinaí' });
  }
});

/* POST /asistencia/exoditos/sinai */
router.post('/asistencia/exoditos/sinai', auth, async (req, res) => {
  const { asistencias, fecha } = req.body;

  if (!Array.isArray(asistencias) || asistencias.length === 0) {
    return res.status(400).json({ error: 'No hay asistencias para registrar' });
  }

  const fechaRegistro = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)
    ? fecha
    : new Date().toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const { id_exodito } of asistencias) {
      await client.query(
        `INSERT INTO asistencia_exodito_sinai (id_exodito, fecha, estado)
         VALUES ($1, $2, 'Sinaí')
         ON CONFLICT (id_exodito, fecha) DO UPDATE SET estado = 'Sinaí'`,
        [id_exodito, fechaRegistro]
      );
    }

    await client.query('COMMIT');

    res.json({
      message: 'Asistencia Sinaí registrada correctamente',
      total: asistencias.length,
      fecha: fechaRegistro,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al registrar asistencia Sinaí' });
  } finally {
    client.release();
  }
});

/* DELETE /asistencia/exoditos/sinai */
router.delete('/asistencia/exoditos/sinai', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM asistencia_exodito_sinai`);
    res.json({
      mensaje: 'Asistencia Sinaí eliminada',
      eliminados: result.rowCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar asistencia Sinaí' });
  }
});

/* GET /asistencia/exodito/:id_exodito/buscar */
router.get('/asistencia/exodito/:id_exodito/buscar', auth, async (req, res) => {
  const { id_exodito } = req.params;
  const { desde, hasta } = req.query;

  try {
    const exoditoResult = await pool.query(
      `SELECT e.id_exodito, e.nombre, e.apellido, e.cargo, t.nombre AS tribu
       FROM exodito e
       JOIN tribu t ON e.id_tribu = t.id_tribu
       WHERE e.id_exodito = $1`,
      [id_exodito]
    );

    if (exoditoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Exodito no encontrado' });
    }

    const exodito = exoditoResult.rows[0];

    const totalFechasResult = await pool.query(
      `SELECT COUNT(DISTINCT fecha) AS total FROM asistencia_exodito`
    );
    const totalFechas = parseInt(totalFechasResult.rows[0]?.total || 0);

    const fechasResult = await pool.query(
      `SELECT DISTINCT fecha FROM asistencia_exodito WHERE id_exodito = $1 AND estado = 'Presente' ORDER BY fecha`,
      [id_exodito]
    );
    const fechas = fechasResult.rows.map(r => r.fecha);

    const totalAsistencias = fechas.length;
    const porcentajeGlobal = totalFechas > 0 ? Math.round((totalAsistencias / totalFechas) * 100) : 0;

    let rangoPresentes = 0;
    let rangoPosibles = 0;
    let porcentajeRango = 0;
    if (desde && hasta) {
      const rangoFechasResult = await pool.query(
        `SELECT COUNT(DISTINCT fecha) AS total FROM asistencia_exodito WHERE fecha BETWEEN $1 AND $2`,
        [desde, hasta]
      );
      rangoPosibles = parseInt(rangoFechasResult.rows[0]?.total || 0);

      const rangoPresentesResult = await pool.query(
        `SELECT COUNT(DISTINCT fecha) AS total FROM asistencia_exodito WHERE id_exodito = $1 AND fecha BETWEEN $2 AND $3 AND estado = 'Presente'`,
        [id_exodito, desde, hasta]
      );
      rangoPresentes = parseInt(rangoPresentesResult.rows[0]?.total || 0);
      porcentajeRango = rangoPosibles > 0 ? Math.round((rangoPresentes / rangoPosibles) * 100) : 0;
    }

    res.json({
      exodito,
      total_asistencias: totalAsistencias,
      fechas_asistencia: fechas,
      porcentaje_global: porcentajeGlobal,
      porcentaje_rango: porcentajeRango,
      rango_presentes: rangoPresentes,
      rango_posibles: rangoPosibles,
      desde: desde || null,
      hasta: hasta || null,
    });
  } catch (err) {
    console.error('Error en buscar exodito:', err);
    res.status(500).json({ error: 'Error al buscar exodito' });
  }
});

/* GET /asistencia/exoditos/todos */
router.get('/asistencia/exoditos/todos', auth, async (req, res) => {
  const { desde, hasta } = req.query;

  if (!desde || !hasta) {
    return res.status(400).json({ error: 'Se requieren los parámetros "desde" y "hasta"' });
  }

  try {
    const result = await pool.query(`
      SELECT
        t.nombre AS tribu,
        t.color_hex,
        e.id_exodito,
        e.nombre,
        e.apellido,
        e.cargo,
        COUNT(DISTINCT CASE WHEN ae.fecha BETWEEN $1 AND $2 AND ae.estado = 'Presente' THEN ae.fecha END) AS asistencias_rango,
        COUNT(DISTINCT CASE WHEN ae.estado = 'Presente' THEN ae.fecha END) AS total_asistencias,
        (SELECT COUNT(DISTINCT fecha) FROM asistencia_exodito WHERE fecha BETWEEN $1 AND $2) AS rango_posibles
      FROM exodito e
      JOIN tribu t ON e.id_tribu = t.id_tribu
      LEFT JOIN asistencia_exodito ae ON ae.id_exodito = e.id_exodito
      GROUP BY t.id_tribu, t.nombre, t.color_hex, e.id_exodito, e.nombre, e.apellido, e.cargo
      ORDER BY t.id_tribu, e.nombre
    `, [desde, hasta]);

    res.json({ exoditos: result.rows, desde, hasta });
  } catch (err) {
    console.error('Error en todos exoditos:', err);
    res.status(500).json({ error: 'Error al obtener datos de todos los exoditos' });
  }
});

export default router;
