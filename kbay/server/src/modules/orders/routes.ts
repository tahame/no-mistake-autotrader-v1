import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { run } from '../../http/run.js';
import { id, orgIdParams, orgParams, positiveMinor, typed } from '../../http/schemas.js';
import * as svc from './service.js';

export async function ordersRoutes(base: FastifyInstance) {
  const app = typed(base);
  const pos = { module: 'pos' };

  app.post('/orgs/:orgId/orders', {
    schema: { tags: ['pos'], params: orgParams, body: z.object({
      locationId: id,
      lines: z.array(z.object({ variantId: id, qty: z.number().int().min(1).max(1000), modifierIds: z.array(id).max(20).optional(),
        openPriceMinor: positiveMinor.optional() })).min(1).max(100),
      paymentAccountId: id.nullable().optional(),
      note: z.string().max(300).nullable().optional(),
      clientRef: id.nullable().optional(),
    }) },
  }, (req) => run(req, (ctx) => svc.createOrder(ctx, req.params.orgId, req.body), pos));

  app.get('/orgs/:orgId/orders', {
    schema: { tags: ['pos'], params: orgParams, querystring: z.object({ locationId: id, dayId: id.optional(), limit: z.coerce.number().int().min(1).max(500).optional() }) },
  }, (req) => run(req, (ctx) => svc.listOrders(ctx, req.params.orgId, req.query), pos));

  app.post('/orgs/:orgId/orders/:id/void', { schema: { tags: ['pos'], params: orgIdParams, body: z.object({ reason: z.string().min(2).max(300) }) } }, (req) =>
    run(req, (ctx) => svc.voidOrder(ctx, req.params.orgId, req.params.id, req.body.reason), pos));

  app.post('/orgs/:orgId/orders/:id/refunds', {
    schema: { tags: ['pos'], params: orgIdParams, body: z.object({ amountMinor: positiveMinor, reason: z.string().min(2).max(300), accountId: id.nullable().optional() }) },
  }, (req) => run(req, (ctx) => svc.requestRefund(ctx, req.params.orgId, req.params.id, req.body), pos));
}
