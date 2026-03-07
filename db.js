const { Pool } = require('pg');
const DATABASE_URL = 'postgresql://neondb_owner:npg_daWumlH2Qo3v@ep-fancy-water-advwus8e-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on('connect', () => {
  console.log('✅ Conectado a Neon');
});

module.exports = pool;
