import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { env } from './env.js';
import { registerErrorHandler } from './lib/errors.js';
import { authRoutes } from './modules/auth.routes.js';
import { staffRoutes } from './modules/staff.routes.js';
import { patientRoutes } from './modules/patients.routes.js';
import { appointmentRoutes } from './modules/appointments.routes.js';
import { inpatientRoutes } from './modules/inpatient.routes.js';
import { pharmacyRoutes } from './modules/pharmacy.routes.js';
import { labRoutes } from './modules/lab.routes.js';
import { billingRoutes } from './modules/billing.routes.js';
import { dashboardRoutes } from './modules/dashboard.routes.js';
import { auditRoutes } from './modules/audit.routes.js';
import { reportRoutes } from './modules/reports.routes.js';

const app = Fastify({
  logger: env.nodeEnv === 'test' ? false : { level: 'info' }
});

await app.register(cors, {
  origin: env.appOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']
});

await app.register(jwt, { secret: env.jwtSecret });

registerErrorHandler(app);

app.get('/api/health', async () => ({
  status: 'ok',
  time: new Date().toISOString(),
  environment: env.nodeEnv
}));

// Each module is encapsulated so its auth hook does not leak onto others.
await app.register(authRoutes);
await app.register(staffRoutes);
await app.register(patientRoutes);
await app.register(appointmentRoutes);
await app.register(inpatientRoutes);
await app.register(pharmacyRoutes);
await app.register(labRoutes);
await app.register(reportRoutes);
await app.register(billingRoutes);
await app.register(dashboardRoutes);
await app.register(auditRoutes);

app
  .listen({ port: env.port, host: '127.0.0.1' })
  .then(() => app.log.info(`API listening on http://127.0.0.1:${env.port}`))
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
}
