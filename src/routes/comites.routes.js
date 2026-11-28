import { Router } from 'express';
import pool from '../db/db.js';
import { auth, requerirRol } from '../middlewares/auth.js';

const router = Router();

/* GET /comites */
router.get('/comites', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT nombre AS comite FROM comite
       UNION
       SELECT DISTINCT comite FROM dirigente WHERE comite IS NOT NULL AND comite <> ''
       ORDER BY comite ASC`
    );
    res.json(result.rows.map(r => r.comite));
  } catch (err) {
    console.error('Error obteniendo comités:', err);
    res.status(500).json({ error: 'Error al obtener comités' });
  }
});

/* GET /comites/gestion */
router.get('/comites/gestion', auth, async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO comite (nombre, puede_crear_actividades, puede_poner_multas)
      SELECT DISTINCT comite, false, false
      FROM dirigente
      WHERE comite IS NOT NULL AND comite <> ''
      ON CONFLICT (nombre) DO NOTHING;
    `);

    const comitesRes = await pool.query(`
      SELECT id_comite, nombre,
             COALESCE(puede_crear_actividades, false) AS puede_crear_actividades,
             COALESCE(puede_poner_multas, false) AS puede_poner_multas
      FROM comite
      ORDER BY nombre ASC
    `);

    const dirigentesRes = await pool.query(`
      SELECT id_dirigente, nombre, apellido, rol, comite, foto
      FROM dirigente
      WHERE comite IS NOT NULL AND comite <> ''
      ORDER BY nombre ASC, apellido ASC
    `);

    const comites = comitesRes.rows.map(c => {
      const integrantes = dirigentesRes.rows.filter(
        d => d.comite && d.comite.trim().toLowerCase() === c.nombre.trim().toLowerCase()
      );
      return {
        ...c,
        integrantes
      };
    });

    res.json(comites);
  } catch (err) {
    console.error('Error obteniendo comités para gestión:', err);
    res.status(500).json({ error: 'Error al obtener comités para gestión' });
  }
});

/* GET /comites/mis-permisos */
router.get('/comites/mis-permisos', auth, async (req, res) => {
  try {
    const idAutor = req.user.id_dirigente;
    const result = await pool.query(
      `SELECT d.id_dirigente, d.rol, d.comite,
              COALESCE(c.puede_crear_actividades, false) AS puede_crear_actividades,
              COALESCE(c.puede_poner_multas, false) AS puede_poner_multas
       FROM dirigente d
       LEFT JOIN comite c ON LOWER(c.nombre) = LOWER(d.comite)
       WHERE d.id_dirigente = $1`,
      [idAutor]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dirigente no encontrado' });
    }

    const d = result.rows[0];
    const rolNorm = (d.rol || '').trim().toLowerCase();
    const esCoord = ['coordinacion', 'coordinación', 'admin'].includes(rolNorm);

    const comitesPermitidosRes = await pool.query(
      `SELECT nombre FROM comite WHERE puede_crear_actividades = true ORDER BY nombre ASC`
    );
    const comitesConPermiso = comitesPermitidosRes.rows.map(r => r.nombre);

    res.json({
      esCoordinacion: esCoord,
      comite: d.comite || null,
      puede_crear_actividades: esCoord || Boolean(d.puede_crear_actividades),
      puede_poner_multas: esCoord || Boolean(d.puede_poner_multas),
      comites_con_permiso_actividades: comitesConPermiso
    });
  } catch (err) {
    console.error('Error consultando mis permisos:', err);
    res.status(500).json({ error: 'Error al consultar permisos de comité' });
  }
});

/* PUT /comite/permisos */
router.put('/comite/permisos', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const { nombre, puede_crear_actividades, puede_poner_multas } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre del comité es obligatorio' });
  }

  try {
    await pool.query(
      `INSERT INTO comite (nombre, puede_crear_actividades, puede_poner_multas)
       VALUES ($1, false, false)
       ON CONFLICT (nombre) DO NOTHING`,
      [nombre.trim()]
    );

    const result = await pool.query(
      `UPDATE comite
       SET puede_crear_actividades = COALESCE($1, puede_crear_actividades),
           puede_poner_multas = COALESCE($2, puede_poner_multas)
       WHERE LOWER(nombre) = LOWER($3)
       RETURNING *`,
      [
        puede_crear_actividades === undefined ? null : Boolean(puede_crear_actividades),
        puede_poner_multas === undefined ? null : Boolean(puede_poner_multas),
        nombre.trim()
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comité no encontrado' });
    }

    res.json({
      mensaje: 'Permisos actualizados correctamente',
      comite: result.rows[0]
    });
  } catch (err) {
    console.error('Error actualizando permisos del comité:', err);
    res.status(500).json({ error: 'Error al actualizar permisos del comité' });
  }
});

/* POST /comite */
router.post('/comite', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const { nombre, puede_crear_actividades, puede_poner_multas } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre del comité es obligatorio' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO comite (nombre, puede_crear_actividades, puede_poner_multas)
       VALUES ($1, $2, $3)
       ON CONFLICT (nombre) DO UPDATE
       SET puede_crear_actividades = EXCLUDED.puede_crear_actividades,
           puede_poner_multas = EXCLUDED.puede_poner_multas
       RETURNING *`,
      [nombre.trim(), Boolean(puede_crear_actividades), Boolean(puede_poner_multas)]
    );
    res.status(201).json({ mensaje: 'Comité creado', comite: result.rows[0] });
  } catch (err) {
    console.error('Error creando comité:', err);
    res.status(500).json({ error: 'Error al crear comité' });
  }
});

/* DELETE /comite */
router.delete('/comite', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Se requiere el nombre del comité' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM comite WHERE LOWER(nombre) = LOWER($1)`, [nombre.trim()]);
    const result = await client.query(
      `UPDATE dirigente SET comite = NULL WHERE LOWER(comite) = LOWER($1) RETURNING id_dirigente`,
      [nombre.trim()]
    );
    await client.query('COMMIT');
    res.json({ mensaje: 'Comité eliminado', afectados: result.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error eliminando comité:', err);
    res.status(500).json({ error: 'Error al eliminar comité' });
  } finally {
    client.release();
  }
});

export default router;
