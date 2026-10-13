import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { config } from './config.js';
import { AppError, fromDbError } from './core/errors.js';
import { authHook } from './http/run.js';
import { approvalsRoutes } from './modules/approvals/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { financeRoutes } from './modules/finance/routes.js';
import { identityRoutes } from './modules/identity/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { notificationsRoutes } from './modules/notifications/routes.js';
import { ordersRoutes } from './modules/orders/routes.js';
import { ownerRoutes } from './modules/owner/routes.js';
import { reportingRoutes } from './modules/reporting/routes.js';
import { tenancyRoutes } from './modules/tenancy/routes.js';
import { db } from './db/db.js';
import { wire } from './wiring.js';

/**
 * Builds the HTTP application. The API (/api/v1, documented at /api/docs) is the only way the
 * front end — or any future app, like the customer-ordering Android app — talks to the back end.
 */
export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  wire();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1_000_000,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: { info: { title: 'Opplox platform API', version: '1.0.0', description: 'K-BAY operations — Phase 1' } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/')) await authHook(req);
  });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: { code: 'invalid_input', message: 'Some fields are missing or wrong.', details: err.validation } });
    }
    const appErr = err instanceof AppError ? err : fromDbError(err);
    if (appErr) {
      if (appErr.status >= 500) req.log.error(err);
      return reply.status(appErr.status).send({ error: { code: appErr.code, message: appErr.message, details: appErr.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: 'request_error', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'server_error', message: 'Something went wrong. It has been logged.' } });
  });

  app.get('/healthz', async () => {
    await db()`select 1`;
    return { ok: true };
  });

  await app.register(async (api) => {
    for (const r of [identityRoutes, tenancyRoutes, catalogRoutes, inventoryRoutes, financeRoutes, ordersRoutes, approvalsRoutes,
      notificationsRoutes, reportingRoutes, auditRoutes, ownerRoutes]) {
      await api.register(r);
    }
  }, { prefix: '/api/v1' });

  // Serve the built web app (PWA) with SPA fallback.
  const webDist = config.WEB_DIST ?? path.resolve(process.cwd(), '../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, maxAge: '1h', setHeaders: (res, file) => {
      if (file.endsWith('sw.js') || file.endsWith('index.html') || file.endsWith('manifest.webmanifest')) res.header('Cache-Control', 'no-cache');
    } });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html');
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  }
  return app;
}
