import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { run } from '../../http/run.js';
import { minor, orgIdParams, orgParams, typed } from '../../http/schemas.js';
import * as svc from './service.js';

export async function tenancyRoutes(base: FastifyInstance) {
  const app = typed(base);

  app.get('/workspace', { schema: { tags: ['org'] } }, (req) => run(req, (ctx) => svc.myWorkspace(ctx), { allowPasswordChange: true }));

  app.post('/orgs', {
    schema: { tags: ['org'], body: z.object({ name: z.string().min(2).max(100), slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
      brandName: z.string().min(1).max(60), currency: z.string().length(3).optional(), timezone: z.string().optional() }) },
  }, (req) => run(req, (ctx) => svc.createOrg(ctx, req.body)));

  app.patch('/orgs/:orgId', {
    schema: { tags: ['org'], params: orgParams, body: z.object({ name: z.string().optional(), brandName: z.string().optional(),
      currency: z.string().length(3).optional(), timezone: z.string().optional(), settings: z.record(z.string(), z.unknown()).optional() }) },
  }, (req) => run(req, (ctx) => svc.updateOrg(ctx, req.params.orgId, req.body)));

  app.get('/orgs/:orgId/locations', { schema: { tags: ['org'], params: orgParams } }, (req) =>
    run(req, (ctx) => svc.listLocations(ctx, req.params.orgId)));

  app.post('/orgs/:orgId/locations', {
    schema: { tags: ['org'], params: orgParams, body: z.object({ name: z.string().min(2).max(80), kind: z.enum(['stall', 'shop']),
      city: z.string().max(80).optional(), address: z.string().max(300).optional(), approvalLimitMinor: minor }) },
  }, (req) => run(req, (ctx) => svc.createLocation(ctx, req.params.orgId, req.body)));

  app.patch('/orgs/:orgId/locations/:id', {
    schema: { tags: ['org'], params: orgIdParams, body: z.object({ name: z.string().min(2).max(80).optional(), kind: z.enum(['stall', 'shop']).optional(),
      city: z.string().max(80).nullable().optional(), address: z.string().max(300).nullable().optional(), approvalLimitMinor: minor.optional(),
      active: z.boolean().optional() }) },
  }, (req) => run(req, (ctx) => svc.updateLocation(ctx, req.params.orgId, req.params.id, req.body)));

  app.get('/orgs/:orgId/people', { schema: { tags: ['people'], params: orgParams } }, (req) =>
    run(req, (ctx) => svc.listPeople(ctx, req.params.orgId)));

  const person = z.object({ fullName: z.string().min(2).max(120), displayName: z.string().max(60).optional(), phone: z.string().max(30).optional(),
    email: z.email().optional(), cnic: z.string().max(20).optional(), address: z.string().max(300).optional(), notes: z.string().max(2000).optional() });

  app.post('/orgs/:orgId/people', { schema: { tags: ['people'], params: orgParams, body: person } }, (req) =>
    run(req, (ctx) => svc.createPerson(ctx, req.params.orgId, req.body)));

  app.patch('/orgs/:orgId/people/:id', { schema: { tags: ['people'], params: orgIdParams, body: person.partial() } }, (req) =>
    run(req, (ctx) => svc.updatePerson(ctx, req.params.orgId, req.params.id, req.body)));

  app.post('/orgs/:orgId/people/:id/link', { schema: { tags: ['people'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => svc.linkPersonToOrg(ctx, req.params.orgId, req.params.id)));

}
