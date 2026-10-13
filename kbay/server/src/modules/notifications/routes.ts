import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { run } from '../../http/run.js';
import { id, orgParams, typed } from '../../http/schemas.js';
import * as svc from './service.js';

export async function notificationsRoutes(base: FastifyInstance) {
  const app = typed(base);

  app.get('/notifications', { schema: { tags: ['notifications'], querystring: z.object({ unread: z.coerce.boolean().optional() }) } }, (req) =>
    run(req, async (ctx) => ({ items: await svc.listMine(ctx, { unreadOnly: req.query.unread }), unread: await svc.unreadCount(ctx) })));

  app.post('/notifications/read', { schema: { tags: ['notifications'], body: z.object({ ids: z.union([z.array(id), z.literal('all')]) }) } }, (req) =>
    run(req, (ctx) => svc.markRead(ctx, req.body.ids)));

  app.get('/notifications/prefs', { schema: { tags: ['notifications'] } }, (req) => run(req, (ctx) => svc.myPrefs(ctx)));

  app.post('/notifications/prefs', { schema: { tags: ['notifications'], body: z.object({ type: z.string(), enabled: z.boolean() }) } }, (req) =>
    run(req, (ctx) => svc.setMyPref(ctx, req.body.type, req.body.enabled)));

  app.get('/push/key', { schema: { tags: ['notifications'] } }, async () => ({ publicKey: config.VAPID_PUBLIC_KEY ?? null }));

  app.post('/push/subscribe', {
    schema: { tags: ['notifications'], body: z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }) },
  }, (req) => run(req, (ctx) => svc.savePushSubscription(ctx, req.body)));

  app.get('/orgs/:orgId/notification-settings', { schema: { tags: ['notifications'], params: orgParams } }, (req) =>
    run(req, (ctx) => svc.orgSettings(ctx, req.params.orgId)));

  app.post('/orgs/:orgId/notification-settings', {
    schema: { tags: ['notifications'], params: orgParams, body: z.object({ type: z.string(), enabled: z.boolean(), config: z.record(z.string(), z.unknown()).default({}) }) },
  }, (req) => run(req, (ctx) => svc.setOrgSetting(ctx, req.params.orgId, req.body.type, req.body.enabled, req.body.config)));
}
