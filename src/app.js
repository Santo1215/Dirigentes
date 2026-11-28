import path from 'path';
import express from 'express';
import cors from 'cors';

// Rutas modulares
import authRoutes from './routes/auth.routes.js';
import dirigentesRoutes from './routes/dirigentes.routes.js';
import tribusRoutes from './routes/tribus.routes.js';
import comitesRoutes from './routes/comites.routes.js';
import asistenciaRoutes from './routes/asistencia.routes.js';
import multasRoutes from './routes/multas.routes.js';
import exoditosRoutes from './routes/exoditos.routes.js';
import actividadesRoutes from './routes/actividades.routes.js';
import materialesRoutes from './routes/materiales.routes.js';
import asambleasRoutes from './routes/asambleas.routes.js';
import notificacionesRoutes from './routes/notificaciones.routes.js';
import sugerenciasRoutes from './routes/sugerencias.routes.js';
import adminRoutes from './routes/admin.routes.js';

// Middlewares
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

const app = express();

// Confiar en el proxy inverso de Render para identificar la IP real del cliente
app.set('trust proxy', 1);

// Middlewares globales
app.use(cors());
app.use(express.json());

// Archivos estáticos
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Endpoint de prueba / health check
app.get('/', (req, res) => {
  res.json({ ok: true, name: 'diris-backend', version: '2.0.0' });
});

// Registro de rutas
app.use(authRoutes);
app.use(dirigentesRoutes);
app.use(tribusRoutes);
app.use(comitesRoutes);
app.use(asistenciaRoutes);
app.use(multasRoutes);
app.use(exoditosRoutes);
app.use(actividadesRoutes);
app.use(materialesRoutes);
app.use(asambleasRoutes);
app.use(notificacionesRoutes);
app.use(sugerenciasRoutes);
app.use(adminRoutes);

// Manejadores de error
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
