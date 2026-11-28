import 'dotenv/config';
import app from './src/app.js';
import { runMigrations } from './src/db/migrations.js';

const PORT = process.env.PORT || 3000;

// Ejecutar migraciones automáticas al iniciar
runMigrations().catch(err => {
  console.error('Error inicializando base de datos:', err);
});

// Iniciar servidor HTTP
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`);
});
