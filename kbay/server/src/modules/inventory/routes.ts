import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { run } from '../../http/run.js';
import { id, orgIdParams, orgParams, qty, typed } from '../../http/schemas.js';
import { openDayFor } from '../finance/index.js';
import * as svc from './service.js';

export async function inventoryRoutes(base: FastifyInstance) {
  const app = typed(base);
  const opts = { module: 'inventory' };

  app.get('/orgs/:orgId/stock-items', { schema: { tags: ['inventory'], params: orgParams } }, (req) =>
    run(req, (ctx) => svc.listItems(ctx, req.params.orgId), opts));

  app.post('/orgs/:orgId/stock-items', {
    schema: { tags: ['inventory'], params: orgParams, body: z.object({ id: id.optional(), parentId: id.nullable().optional(), name: z.string().min(1).max(80),
      category: z.string().min(1).max(40), kind: z.enum(['stock', 'mix', 'family']), dimension: z.enum(['mass', 'volume', 'count']),
      purchaseUnit: z.string(), tracking: z.enum(['precise', 'bulk']), costClass: z.enum(['food', 'beverage', 'packaging', 'fuel']),
      lowStock: qty.nullable().optional(), active: z.boolean().optional() }) },
  }, (req) => run(req, (ctx) => svc.upsertItem(ctx, req.params.orgId, req.body), opts));

  app.put('/orgs/:orgId/stock-items/:id/mix', {
    schema: { tags: ['inventory'], params: orgIdParams, body: z.object({ components: z.array(z.object({ itemId: id, qty, unit: z.string() })) }) },
  }, (req) => run(req, (ctx) => svc.setMixComponents(ctx, req.params.orgId, req.params.id, req.body.components), opts));

  app.get('/orgs/:orgId/varieties', { schema: { tags: ['inventory'], params: orgParams, querystring: z.object({ locationId: id }) } }, (req) =>
    run(req, (ctx) => svc.listVarieties(ctx, req.params.orgId, req.query.locationId), opts));

  app.post('/orgs/:orgId/varieties', {
    schema: { tags: ['inventory'], params: orgParams, body: z.object({ locationId: id, familyId: id, varietyId: id }) },
  }, (req) => run(req, (ctx) => svc.setVariety(ctx, req.params.orgId, req.body.locationId, req.body.familyId, req.body.varietyId), opts));

  app.get('/orgs/:orgId/recipes/:id', { schema: { tags: ['inventory'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => svc.getRecipe(ctx, req.params.orgId, req.params.id), opts));

  app.put('/orgs/:orgId/recipes/:id', {
    schema: { tags: ['inventory'], params: orgIdParams, body: z.object({ lines: z.array(z.object({ itemId: id, qty, unit: z.string(),
      stage: z.enum(['prep', 'fry', 'serve']) })) }) },
  }, (req) => run(req, (ctx) => svc.setRecipe(ctx, req.params.orgId, req.params.id, req.body.lines), opts));

  app.get('/orgs/:orgId/plate-costs', { schema: { tags: ['inventory'], params: orgParams, querystring: z.object({ locationId: id }) } }, (req) =>
    run(req, (ctx) => svc.plateCosts(ctx, req.params.orgId, req.query.locationId), opts));

  app.get('/orgs/:orgId/stock', { schema: { tags: ['inventory'], params: orgParams, querystring: z.object({ locationId: id }) } }, (req) =>
    run(req, (ctx) => svc.stockLevels(ctx, req.params.orgId, req.query.locationId), opts));

  app.get('/orgs/:orgId/stock/movements', {
    schema: { tags: ['inventory'], params: orgParams, querystring: z.object({ locationId: id, itemId: id.optional() }) },
  }, (req) => run(req, (ctx) => svc.listMovements(ctx, req.params.orgId, req.query.locationId, req.query.itemId), opts));

  app.post('/orgs/:orgId/waste', {
    schema: { tags: ['inventory'], params: orgParams, body: z.object({ locationId: id, itemId: id, qty, unit: z.string(),
      wasteClass: z.enum(['food', 'beverage', 'other']), reason: z.string().min(2).max(300), businessDayId: id.nullable().optional() }) },
  }, (req) => run(req, async (ctx) => {
    // Waste joins the open day at that location, like expenses and purchases do.
    const dayId = req.body.businessDayId ?? (await openDayFor(ctx.tx, req.body.locationId))?.id ?? null;
    return svc.recordWaste(ctx, req.params.orgId, { ...req.body, businessDayId: dayId });
  }, opts));

  app.get('/orgs/:orgId/stock-requests', {
    schema: { tags: ['inventory'], params: orgParams, querystring: z.object({ status: z.enum(['open', 'done', 'cancelled', 'all']).default('open'), locationId: id.optional() }) },
  }, (req) => run(req, (ctx) => svc.listStockRequests(ctx, req.params.orgId, req.query.status, req.query.locationId), opts));

  app.post('/orgs/:orgId/stock-requests', {
    schema: { tags: ['inventory'], params: orgParams, body: z.object({ locationId: id, itemId: id.nullable().optional(), note: z.string().min(2).max(500) }) },
  }, (req) => run(req, (ctx) => svc.createStockRequest(ctx, req.params.orgId, req.body), opts));

  app.post('/orgs/:orgId/stock-requests/:id/close', {
    schema: { tags: ['inventory'], params: orgIdParams, body: z.object({ status: z.enum(['done', 'cancelled']) }) },
  }, (req) => run(req, (ctx) => svc.closeStockRequest(ctx, req.params.orgId, req.params.id, req.body.status), opts));

  app.get('/orgs/:orgId/stock-counts', { schema: { tags: ['inventory'], params: orgParams, querystring: z.object({ locationId: id }) } }, (req) =>
    run(req, (ctx) => svc.listCounts(ctx, req.params.orgId, req.query.locationId), opts));

  app.post('/orgs/:orgId/stock-counts', {
    schema: { tags: ['inventory'], params: orgParams, body: z.object({ locationId: id, note: z.string().max(500).optional(),
      lines: z.array(z.object({ itemId: id, counted: qty, unit: z.string() })).min(1) }) },
  }, (req) => run(req, (ctx) => svc.postCount(ctx, req.params.orgId, req.body), opts));
}
