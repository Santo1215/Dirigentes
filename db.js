const { Pool } = require('pg');
const DATABASE_URL = 'postgresql://neondb_owner:npg_GS0OH3AmwxlW@ep-small-forest-afkx2784-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
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
