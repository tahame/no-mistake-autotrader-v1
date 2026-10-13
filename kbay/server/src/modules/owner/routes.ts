import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../http/run.js';
import { id, typed } from '../../http/schemas.js';
import * as svc from './service.js';

export async function ownerRoutes(base: FastifyInstance) {
  const app = typed(base);

  app.get('/owner/tenants', { schema: { tags: ['owner'] } }, async (req) => {
    svc.requireOwner(requireAuth(req));
    return svc.tenants();
  });

  app.patch('/owner/tenants/:id', {
    schema: { tags: ['owner'], params: z.object({ id }), body: z.object({ active: z.boolean().optional(), otpEnabled: z.boolean().optional(),
      modules: z.record(z.string(), z.boolean()).optional() }) },
  }, async (req) => {
    await svc.updateTenant(requireAuth(req), req.params.id, req.body);
    return { ok: true };
  });

  app.get('/owner/health', { schema: { tags: ['owner'] } }, async (req) => {
    svc.requireOwner(requireAuth(req));
    return svc.health();
  });

  app.get('/owner/modules', { schema: { tags: ['owner'] } }, async (req) => {
    svc.requireOwner(requireAuth(req));
    return svc.MODULES;
  });
}
