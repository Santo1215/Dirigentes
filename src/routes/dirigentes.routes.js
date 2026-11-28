import { Router } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../db/db.js';
import { auth, requerirRol } from '../middlewares/auth.js';
import { generarContrasena, generarCodigoUnico } from '../utils/crypto.js';

const router = Router();

/* POST /dirigente */
router.post('/dirigente', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const { nombre, segundo_nombre, apellido, rol, comite, id_tribu } = req.body;

  if (!nombre || !apellido || !rol) {
    return res.status(400).json({ message: 'Faltan datos obligatorios' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const contrasenaPlano = generarContrasena();
    const codigo = await generarCodigoUnico(client);
    const contrasenaHash = await bcrypt.hash(contrasenaPlano, 12);
    
    const dirigenteResult = await client.query(
      `
      INSERT INTO dirigente
      (nombre, segundo_nombre, apellido, rol, comite, id_tribu, contrasena, codigo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        nombre,
        segundo_nombre && segundo_nombre.trim() !== '' ? segundo_nombre : null,
        apellido,
        rol,
        comite,
        id_tribu,
        contrasenaHash,
        codigo
      ]
    );

    const dirigente = dirigenteResult.rows[0];

    const usuarioGenerado =
      nombre.replace(/\s+/g, '') +
      apellido.replace(/\s+/g, '') +
      dirigente.id_dirigente;

    await client.query(
      `
      UPDATE dirigente
      SET usuario = $1
      WHERE id_dirigente = $2
      `,
      [usuarioGenerado, dirigente.id_dirigente]
    );

    const codigoQR = `DIR-${dirigente.nombre}-${dirigente.apellido}-${dirigente.id_dirigente}`;

    await client.query(
      `
      INSERT INTO qr_personal (id_dirigente, codigo_qr)
      VALUES ($1, $2)
      `,
      [dirigente.id_dirigente, codigoQR]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Dirigente creado correctamente',
      dirigente: {
        id_dirigente: dirigente.id_dirigente,
        nombre: dirigente.nombre,
        apellido: dirigente.apellido,
        usuario: usuarioGenerado,
        contrasena: contrasenaPlano,
        codigo: codigo,
        rol: dirigente.rol,
        comite: dirigente.comite,
        id_tribu: dirigente.id_tribu,
        codigo_qr: codigoQR
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creando dirigente:', error.message);
    return res.status(500).json({ error: 'Error al crear dirigente' });
  } finally {
    client.release();
  }
});

/* GET /dirigente/:id/qr */
router.get('/dirigente/:id/qr', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT codigo_qr
      FROM qr_personal
      WHERE id_dirigente = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'QR no encontrado' });
    }

    res.json({ codigo_qr: result.rows[0].codigo_qr });
  } catch (error) {
    console.error('Error obteniendo QR:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/* GET /dirigentes */
router.get('/dirigentes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id_dirigente, nombre, segundo_nombre, apellido, rol, comite, id_tribu, id_tribu_secundaria, curso, foto, codigo, usuario
      FROM dirigente
      ORDER BY nombre ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener los dirigentes' });
  }
});

/* PUT /dirigente/:id */
router.put('/dirigente/:id', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { rol, comite, id_tribu, id_tribu_secundaria, curso } = req.body;

  if (!rol) {
    return res.status(400).json({ message: 'El rol es obligatorio' });
  }

  try {
    const result = await pool.query(
      `
      UPDATE dirigente
      SET rol = $1, comite = $2, id_tribu = $3, id_tribu_secundaria = $4, curso = $5
      WHERE id_dirigente = $6
      RETURNING id_dirigente, nombre, apellido, rol, comite, id_tribu, id_tribu_secundaria, curso
      `,
      [rol, comite || null, id_tribu || null, id_tribu_secundaria || null, curso || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Dirigente no encontrado' });
    }

    res.json({
      message: 'Dirigente actualizado',
      dirigente: result.rows[0],
    });
  } catch (error) {
    console.error('Error actualizando dirigente:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

/* DELETE /dirigente/:id */
router.delete('/dirigente/:id', auth, requerirRol('coordinación', 'coordinacion', 'admin'), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const check = await client.query(
      'SELECT nombre, apellido FROM dirigente WHERE id_dirigente = $1',
      [id]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Dirigente no encontrado' });
    }

    await client.query('DELETE FROM multa WHERE id_dirigente = $1', [id]);
    await client.query('DELETE FROM asistencia WHERE id_dirigente = $1', [id]);
    await client.query('DELETE FROM qr_personal WHERE id_dirigente = $1', [id]);
    await client.query('DELETE FROM dirigente WHERE id_dirigente = $1', [id]);

    await client.query('COMMIT');

    res.json({
      message: 'Dirigente eliminado',
      dirigente: check.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error eliminando dirigente:', error);
    res.status(500).json({ message: 'Error del servidor' });
  } finally {
    client.release();
  }
});

/* PUT /dirigente/:id/contrasena */
router.put('/dirigente/:id/contrasena', auth, async (req, res) => {
  const { id } = req.params;
  const { contrasenaActual, contrasenaNueva } = req.body;

  const rolUsuario = (req.user?.rol || '').trim().toLowerCase();
  const esCoordOAdmin = ['coordinacion', 'coordinación', 'admin'].some(r => rolUsuario.includes(r));
  if (parseInt(req.user.id_dirigente, 10) !== parseInt(id, 10) && !esCoordOAdmin) {
    return res.status(403).json({ error: 'Acceso denegado: solo puedes cambiar tu propia contraseña' });
  }

  if (!contrasenaActual || !contrasenaNueva) {
    return res.status(400).json({ message: 'Datos incompletos' });
  }

  try {
    const result = await pool.query(
      `SELECT contrasena FROM dirigente WHERE id_dirigente = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Dirigente no encontrado' });
    }

    const valida = await bcrypt.compare(contrasenaActual, result.rows[0].contrasena);
    if (!valida) {
      return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    }

    const hash = await bcrypt.hash(contrasenaNueva, 12);
    await pool.query(
      `UPDATE dirigente SET contrasena = $1 WHERE id_dirigente = $2`,
      [hash, id]
    );

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    console.error('Error actualizando contraseña:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

export default router;
