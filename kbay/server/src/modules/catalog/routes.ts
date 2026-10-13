import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../core/context.js';
import { forbidden } from '../../core/errors.js';
import { run } from '../../http/run.js';
import { id, minor, orgIdParams, orgParams, typed } from '../../http/schemas.js';
import * as svc from './service.js';

export async function catalogRoutes(base: FastifyInstance) {
  const app = typed(base);

  // The POS menu for one location (only what that stall sells).
  app.get('/orgs/:orgId/menu', { schema: { tags: ['menu'], params: orgParams, querystring: z.object({ locationId: id.optional(), all: z.coerce.boolean().optional() }) } },
    (req) => run(req, async (ctx) => {
      const { orgId } = req.params;
      if (req.query.all) requirePerm(ctx, 'menu.manage', orgId);
      else if (!ctx.access.can('pos.sell', orgId, req.query.locationId) && !ctx.access.can('reports.view', orgId)) throw forbidden();
      return svc.menu(ctx.tx, orgId, { locationId: req.query.locationId, includeDisabled: req.query.all });
    }, { module: 'pos' }));

  app.post('/orgs/:orgId/menu/categories', {
    schema: { tags: ['menu'], params: orgParams, body: z.object({ id: id.optional(), name: z.string().min(1).max(60), kind: z.enum(['food', 'beverage']), sort: z.number().int().optional() }) },
  }, (req) => run(req, (ctx) => svc.upsertCategory(ctx, req.params.orgId, req.body)));

  app.post('/orgs/:orgId/menu/items', {
    schema: { tags: ['menu'], params: orgParams, body: z.object({ id: id.optional(), categoryId: id, name: z.string().min(1).max(80),
      description: z.string().max(500).nullable().optional(), image: z.string().max(300).nullable().optional(), enabled: z.boolean(),
      isDeal: z.boolean().optional(), sort: z.number().int().optional() }) },
  }, (req) => run(req, (ctx) => svc.upsertItem(ctx, req.params.orgId, req.body)));

  app.post('/orgs/:orgId/menu/items/:id/enabled', { schema: { tags: ['menu'], params: orgIdParams, body: z.object({ enabled: z.boolean() }) } }, (req) =>
    run(req, (ctx) => svc.setItemEnabled(ctx, req.params.orgId, req.params.id, req.body.enabled)));

  app.post('/orgs/:orgId/menu/items/:id/location', {
    schema: { tags: ['menu'], params: orgIdParams, body: z.object({ locationId: id, enabled: z.boolean().nullable() }) },
  }, (req) => run(req, (ctx) => svc.setLocationItem(ctx, req.params.orgId, req.body.locationId, req.params.id, req.body.enabled)));

  app.post('/orgs/:orgId/menu/variants', {
    schema: { tags: ['menu'], params: orgParams, body: z.object({ id: id.optional(), menuItemId: id, name: z.string().min(1).max(60),
      sizeTag: z.string().max(30).nullable().optional(), priceMinor: minor, openPrice: z.boolean().optional(),
      recipeBasisMinor: z.number().int().positive().nullable().optional(), enabled: z.boolean().optional(), sort: z.number().int().optional() }) },
  }, (req) => run(req, (ctx) => svc.upsertVariant(ctx, req.params.orgId, req.body)));

  app.put('/orgs/:orgId/menu/variants/:id/deal', {
    schema: { tags: ['menu'], params: orgIdParams, body: z.object({ components: z.array(z.object({ variantId: id, qty: z.number().int().positive() })) }) },
  }, (req) => run(req, (ctx) => svc.setDealComponents(ctx, req.params.orgId, req.params.id, req.body.components)));

  app.post('/orgs/:orgId/menu/modifier-groups', {
    schema: { tags: ['menu'], params: orgParams, body: z.object({ id: id.optional(), name: z.string().min(1).max(60), minSelect: z.number().int().min(0),
      maxSelect: z.number().int().min(1), itemIds: z.array(id),
      modifiers: z.array(z.object({ id: id.optional(), name: z.string().min(1).max(60), priceDeltaMinor: z.number().int(), enabled: z.boolean().optional() })) }) },
  }, (req) => run(req, (ctx) => svc.upsertModifierGroup(ctx, req.params.orgId, req.body)));

  app.get('/orgs/:orgId/taxes', { schema: { tags: ['menu'], params: orgParams } }, (req) => run(req, (ctx) => svc.listTaxes(ctx, req.params.orgId)));

  app.post('/orgs/:orgId/taxes', {
    schema: { tags: ['menu'], params: orgParams, body: z.object({ id: id.optional(), name: z.string().min(1).max(60), rateBps: z.number().int().min(0).max(10000),
      appliesTo: z.enum(['all', 'card']), inclusive: z.boolean(), enabled: z.boolean() }) },
  }, (req) => run(req, (ctx) => svc.upsertTax(ctx, req.params.orgId, req.body)));
}
