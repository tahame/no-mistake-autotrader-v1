import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { run } from '../../http/run.js';
import { date, orgParams, range, typed } from '../../http/schemas.js';
import { getOrg } from '../tenancy/index.js';
import * as svc from './service.js';

export async function reportingRoutes(base: FastifyInstance) {
  const app = typed(base);
  const rep = { module: 'reports' };
  const q = { tags: ['reports'], params: orgParams, querystring: range };

  app.get('/orgs/:orgId/reports/dashboard', { schema: q }, (req) => run(req, (ctx) => svc.dashboard(ctx, req.params.orgId, req.query), rep));
  app.get('/orgs/:orgId/reports/expenses', { schema: q }, (req) => run(req, (ctx) => svc.expensesByCategory(ctx, req.params.orgId, req.query), rep));
  app.get('/orgs/:orgId/reports/stalls', { schema: q }, (req) => run(req, (ctx) => svc.stallComparison(ctx, req.params.orgId, req.query), rep));
  app.get('/orgs/:orgId/reports/plates', { schema: q }, (req) => run(req, (ctx) => svc.plateProfit(ctx, req.params.orgId, req.query), rep));
  app.get('/orgs/:orgId/reports/hours', { schema: q }, (req) => run(req, async (ctx) => {
    const org = await getOrg(ctx.tx, req.params.orgId);
    return svc.salesByHour(ctx, req.params.orgId, { ...req.query, timezone: org.timezone });
  }, rep));
  app.get('/orgs/:orgId/reports/labour', { schema: q }, (req) => run(req, (ctx) => svc.labour(ctx, req.params.orgId, req.query), rep));
  app.get('/orgs/:orgId/reports/voids', { schema: q }, (req) => run(req, (ctx) => svc.voidsAndRefunds(ctx, req.params.orgId, req.query), rep));
  app.get('/orgs/:orgId/reports/pnl', { schema: q }, (req) => run(req, (ctx) => svc.profitAndLoss(ctx, req.params.orgId, req.query), rep));
  app.get('/orgs/:orgId/reports/trial-balance', { schema: { tags: ['reports'], params: orgParams, querystring: z.object({ asOf: date }) } }, (req) =>
    run(req, (ctx) => svc.trialBalance(ctx, req.params.orgId, req.query.asOf), rep));
  app.get('/orgs/:orgId/reports/journal', {
    schema: { tags: ['reports'], params: orgParams, querystring: z.object({ from: date, to: date, sourceType: z.string().optional() }) },
  }, (req) => run(req, (ctx) => svc.journal(ctx, req.params.orgId, req.query), rep));
}
