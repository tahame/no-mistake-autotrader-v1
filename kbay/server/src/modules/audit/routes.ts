import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { run } from '../../http/run.js';
import { orgParams, typed } from '../../http/schemas.js';
import * as svc from './service.js';

export async function auditRoutes(base: FastifyInstance) {
  const app = typed(base);
  app.get('/orgs/:orgId/audit', {
    schema: { tags: ['audit'], params: orgParams, querystring: z.object({ entityType: z.string().optional(), entityId: z.string().optional(),
      action: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }) },
  }, (req) => run(req, (ctx) => svc.listAudit(ctx, req.params.orgId, req.query)));
}
