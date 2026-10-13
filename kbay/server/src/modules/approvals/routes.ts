import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { run } from '../../http/run.js';
import { id, orgIdParams, orgParams, typed } from '../../http/schemas.js';
import * as comments from './comments.js';
import * as svc from './service.js';

export async function approvalsRoutes(base: FastifyInstance) {
  const app = typed(base);

  app.get('/orgs/:orgId/approvals', {
    schema: { tags: ['approvals'], params: orgParams, querystring: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending') }) },
  }, (req) => run(req, (ctx) => svc.list(ctx, req.params.orgId, req.query.status)));

  app.post('/orgs/:orgId/approvals/:id/decide', {
    schema: { tags: ['approvals'], params: orgIdParams, body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional() }) },
  }, (req) => run(req, (ctx) => svc.decide(ctx, req.params.id, req.body.decision, req.body.note)));

  app.post('/orgs/:orgId/approvals/:id/cancel', { schema: { tags: ['approvals'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => svc.cancel(ctx, req.params.id)));

  app.get('/orgs/:orgId/comments', {
    schema: { tags: ['comments'], params: orgParams, querystring: z.object({ entityType: z.string().max(40), entityId: id }) },
  }, (req) => run(req, (ctx) => comments.listComments(ctx, req.query.entityType, req.query.entityId)));

  app.post('/orgs/:orgId/comments', {
    schema: { tags: ['comments'], params: orgParams, body: z.object({ entityType: z.string().max(40), entityId: id, body: z.string().min(1).max(2000),
      parentId: id.nullable().optional(), askUserId: id.nullable().optional(), link: z.string().max(200).optional() }) },
  }, (req) => run(req, (ctx) => comments.addComment(ctx, { ...req.body, orgId: req.params.orgId })));
}
