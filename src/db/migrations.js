import pool from './db.js';

export async function runMigrations() {
  try {
    /* Auto-crear tabla push_tokens si no existe */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id SERIAL PRIMARY KEY,
        id_dirigente INTEGER REFERENCES dirigente(id_dirigente) ON DELETE CASCADE,
        token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(id_dirigente, token)
      );
    `);
    console.log('Tabla push_tokens lista');

    /* Auto-crear tabla web_push_subscriptions si no existe */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS web_push_subscriptions (
        id SERIAL PRIMARY KEY,
        id_dirigente INTEGER REFERENCES dirigente(id_dirigente) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(id_dirigente, endpoint)
      );
    `);
    console.log('Tabla web_push_subscriptions lista');

    /* Auto-crear columna verificar_asistencia en actividades si no existe */
    await pool.query(`
      ALTER TABLE actividades
      ADD COLUMN IF NOT EXISTS verificar_asistencia BOOLEAN NOT NULL DEFAULT true;
    `);
    console.log('Columna verificar_asistencia lista');

    /* Auto-crear tabla asistencia_exodito_sinai si no existe */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS asistencia_exodito_sinai (
        id SERIAL PRIMARY KEY,
        id_exodito INTEGER REFERENCES exodito(id_exodito) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        estado TEXT NOT NULL DEFAULT 'Sinaí',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(id_exodito, fecha)
      );
    `);
    console.log('Tabla asistencia_exodito_sinai lista');

    /* Auto-crear y migrar tabla comite si no existe */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comite (
        id_comite SERIAL PRIMARY KEY,
        nombre TEXT UNIQUE NOT NULL,
        puede_crear_actividades BOOLEAN NOT NULL DEFAULT false,
        puede_poner_multas BOOLEAN NOT NULL DEFAULT false
      );
    `);
    await pool.query(`
      ALTER TABLE comite
      ADD COLUMN IF NOT EXISTS puede_crear_actividades BOOLEAN NOT NULL DEFAULT false;
    `);
    await pool.query(`
      ALTER TABLE comite
      ADD COLUMN IF NOT EXISTS puede_poner_multas BOOLEAN NOT NULL DEFAULT false;
    `);

    const defaultComites = [
      { nombre: 'Asistencia', puede_crear_actividades: false, puede_poner_multas: false },
      { nombre: 'Religioso', puede_crear_actividades: true, puede_poner_multas: false },
      { nombre: 'Puntos', puede_crear_actividades: false, puede_poner_multas: false },
      { nombre: 'Integración', puede_crear_actividades: true, puede_poner_multas: true },
      { nombre: 'Redes', puede_crear_actividades: true, puede_poner_multas: false },
      { nombre: 'Económico', puede_crear_actividades: false, puede_poner_multas: true },
    ];
    for (const c of defaultComites) {
      await pool.query(
        `INSERT INTO comite (nombre, puede_crear_actividades, puede_poner_multas)
         VALUES ($1, $2, $3)
         ON CONFLICT (nombre) DO UPDATE
         SET puede_crear_actividades = COALESCE(comite.puede_crear_actividades, EXCLUDED.puede_crear_actividades),
             puede_poner_multas = COALESCE(comite.puede_poner_multas, EXCLUDED.puede_poner_multas)`,
        [c.nombre, c.puede_crear_actividades, c.puede_poner_multas]
      );
    }
    await pool.query(`
      INSERT INTO comite (nombre, puede_crear_actividades, puede_poner_multas)
      SELECT DISTINCT comite, false, false
      FROM dirigente
      WHERE comite IS NOT NULL AND comite <> ''
      ON CONFLICT (nombre) DO NOTHING;
    `);
    console.log('Tabla comite y columnas de permisos listas');

    /* Auto-crear tabla sugerencia_votos */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sugerencia_votos (
        id SERIAL PRIMARY KEY,
        id_sugerencia INT NOT NULL REFERENCES sugerencias_puntos(id) ON DELETE CASCADE,
        id_dirigente INT NOT NULL REFERENCES dirigente(id_dirigente) ON DELETE CASCADE,
        voto VARCHAR(20) NOT NULL CHECK (voto IN ('Aprobada', 'Rechazada')),
        justificacion TEXT,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(id_sugerencia, id_dirigente)
      );
    `);
    console.log('Tabla sugerencia_votos lista');
  } catch (err) {
    console.error('Error ejecutando migraciones:', err.message);
  }
}
