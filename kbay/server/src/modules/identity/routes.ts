import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unauthorized } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { clearSessionCookie, requireAuth, run, sessionToken, setSessionCookie } from '../../http/run.js';
import { id, orgIdParams, orgParams, typed } from '../../http/schemas.js';
import * as svc from './service.js';

export async function identityRoutes(base: FastifyInstance) {
  const app = typed(base);

  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], body: z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) }) },
  }, async (req, reply) => {
    const r = await svc.login(req.body.username, req.body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(reply, r.token, r.expires);
    return { mustChangePassword: r.mustChangePassword, totpRequired: r.totpRequired };
  });

  app.post('/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    const t = sessionToken(req);
    if (t) await svc.logout(t);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', { schema: { tags: ['auth'] } }, async (req) => {
    if (!req.auth) throw unauthorized();
    const a = req.auth;
    return { user: a.actor, tenantId: a.tenantId, mustChangePassword: a.mustChangePassword, totpEnabled: a.totpEnabled, totpRequired: a.totpRequired };
  });

  app.post('/auth/password', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], body: z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }) },
  }, async (req) => {
    const a = requireAuth(req, { allowPasswordChange: true });
    await svc.changePassword(a.actor.userId, req.body.current, req.body.next, req.ip);
    return { ok: true };
  });

  app.post('/auth/totp/begin', { schema: { tags: ['auth'] } }, async (req) => {
    const a = requireAuth(req);
    return svc.totpBegin(a.actor.userId, a.actor.username);
  });

  app.post('/auth/totp/enable', { schema: { tags: ['auth'], body: z.object({ code: z.string().min(6).max(8) }) } }, async (req) => {
    const a = requireAuth(req);
    await svc.totpEnable(a.actor.userId, req.body.code, a.sessionId);
    return { ok: true };
  });

  app.post('/auth/totp/verify', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], body: z.object({ code: z.string().min(6).max(8) }) },
  }, async (req) => {
    if (!req.auth) throw unauthorized();
    await svc.totpVerifySession(req.auth.actor.userId, req.auth.sessionId, req.body.code);
    return { ok: true };
  });

  app.get('/permissions', { schema: { tags: ['admin'] } }, async (req) => {
    requireAuth(req);
    return Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label }));
  });

  app.get('/orgs/:orgId/users', { schema: { tags: ['admin'], params: orgParams } }, (req) =>
    run(req, (ctx) => svc.listUsers(ctx, req.params.orgId)));

  app.post('/orgs/:orgId/users', {
    schema: { tags: ['admin'], params: orgParams, body: z.object({ personId: id, username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i) }) },
  }, (req) => run(req, (ctx) => svc.createUser(ctx, req.params.orgId, req.body)));

  app.post('/orgs/:orgId/users/:id/reset-password', { schema: { tags: ['admin'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => svc.resetPassword(ctx, req.params.orgId, req.params.id)));

  app.post('/orgs/:orgId/users/:id/active', { schema: { tags: ['admin'], params: orgIdParams, body: z.object({ active: z.boolean() }) } }, (req) =>
    run(req, (ctx) => svc.setUserActive(ctx, req.params.orgId, req.params.id, req.body.active)));

  app.get('/orgs/:orgId/roles', { schema: { tags: ['admin'], params: orgParams } }, (req) => run(req, (ctx) => svc.listRoles(ctx)));

  app.post('/orgs/:orgId/roles', {
    schema: { tags: ['admin'], params: orgParams, body: z.object({ id: id.optional(), key: z.string().min(2).max(40).regex(/^[a-z0-9_]+$/),
      name: z.string().min(2).max(80), description: z.string().max(500).optional(), permissions: z.array(z.string()).max(100) }) },
  }, (req) => run(req, (ctx) => svc.upsertRole(ctx, req.params.orgId, req.body)));

  app.post('/orgs/:orgId/role-assignments', {
    schema: { tags: ['admin'], params: orgParams, body: z.object({ userId: id, roleId: id, allOrgs: z.boolean(), orgIds: z.array(id), locationIds: z.array(id) }) },
  }, (req) => run(req, (ctx) => svc.assignRole(ctx, req.params.orgId, req.body)));

  app.delete('/orgs/:orgId/role-assignments/:id', { schema: { tags: ['admin'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => svc.revokeRole(ctx, req.params.orgId, req.params.id)));

  app.post('/orgs/:orgId/permission-overrides', {
    schema: { tags: ['admin'], params: orgParams, body: z.object({ userId: id, permission: z.string(), effect: z.enum(['grant', 'deny', 'clear']),
      scopeOrgId: id.nullable() }) },
  }, (req) => run(req, (ctx) => svc.setOverride(ctx, req.params.orgId, req.body)));
}
