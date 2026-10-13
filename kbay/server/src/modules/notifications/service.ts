import webpush from 'web-push';
import { config } from '../../config.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest } from '../../core/errors.js';
import type { Tx } from '../../db/db.js';
import { withSystem } from '../../db/db.js';

// Every alert has a clear rule for who gets it and its own on/off switch, at org level
// (notification_settings) and per person (user_notification_prefs). All on by default.
export const NOTIFICATION_TYPES = {
  daily_close_reminder: { label: 'Daily closing reminder', who: 'Stall lead', defaults: { time: '23:00' } },
  approval_request: { label: 'Approval request', who: 'The approver', defaults: {} },
  approval_reminder: { label: 'Approval follow-up', who: 'The approver, until actioned', defaults: { everyHours: 2 } },
  approval_decided: { label: 'Approval decision', who: 'The person who asked', defaults: {} },
  low_stock: { label: 'Low stock alert', who: 'Stall lead and partners', defaults: {} },
  daily_summary: { label: 'Daily summary', who: 'All partners', defaults: {} },
  question_asked: { label: 'Question on an entry', who: 'The person asked', defaults: {} },
  question_followup: { label: 'Unanswered question follow-up', who: 'The person asked', defaults: { afterHours: 24 } },
  payout_made: { label: 'Payout made', who: 'All partners', defaults: {} },
  loan_refund_confirm: { label: 'Confirm refund received', who: 'The lender', defaults: {} },
} as const;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export interface NotifyInput {
  tenantId: string;
  orgId: string;
  userIds: string[];
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  dedupeKey?: string;
}

export async function orgSetting(tx: Tx, orgId: string, type: NotificationType) {
  const [r] = await tx<{ enabled: boolean; config: Record<string, unknown> }[]>`
    select enabled, config from core.notification_settings where org_id = ${orgId} and type = ${type}`;
  return { enabled: r?.enabled ?? true, config: { ...NOTIFICATION_TYPES[type].defaults, ...(r?.config ?? {}) } as Record<string, unknown> };
}

/** Queue in-app notifications (push delivery follows from the worker). Returns how many were created. */
export async function notify(tx: Tx, n: NotifyInput): Promise<number> {
  const users = [...new Set(n.userIds)];
  if (users.length === 0) return 0;
  const setting = await orgSetting(tx, n.orgId, n.type);
  if (!setting.enabled) return 0;
  const rows = await tx`
    insert into core.notifications (tenant_id, org_id, user_id, type, title, body, link, dedupe_key)
    select ${n.tenantId}, ${n.orgId}, u.id, ${n.type}, ${n.title}, ${n.body ?? ''}, ${n.link ?? null}, ${n.dedupeKey ?? null}
    from unnest(${users}::uuid[]) as u(id)
    where not exists (select 1 from core.user_notification_prefs p where p.user_id = u.id and p.type = ${n.type} and not p.enabled)
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
    returning id`;
  return rows.count;
}

export async function listMine(ctx: Ctx, opts: { unreadOnly?: boolean; limit?: number }) {
  return ctx.tx`
    select id, org_id, type, title, body, link, created_at, read_at from core.notifications
    where user_id = ${ctx.actor.userId} and (${opts.unreadOnly ?? false} = false or read_at is null)
    order by created_at desc limit ${opts.limit ?? 50}`;
}

export async function unreadCount(ctx: Ctx) {
  const [r] = await ctx.tx<{ n: number }[]>`select count(*)::int as n from core.notifications where user_id = ${ctx.actor.userId} and read_at is null`;
  return r?.n ?? 0;
}

export async function markRead(ctx: Ctx, ids: string[] | 'all') {
  if (ids === 'all') await ctx.tx`update core.notifications set read_at = now() where user_id = ${ctx.actor.userId} and read_at is null`;
  else await ctx.tx`update core.notifications set read_at = now() where user_id = ${ctx.actor.userId} and id = any(${ids}::uuid[])`;
}

export async function myPrefs(ctx: Ctx) {
  const rows = await ctx.tx<{ type: string; enabled: boolean }[]>`
    select type, enabled from core.user_notification_prefs where user_id = ${ctx.actor.userId}`;
  const map = new Map(rows.map((r) => [r.type, r.enabled]));
  return Object.entries(NOTIFICATION_TYPES).map(([type, t]) => ({ type, label: t.label, who: t.who, enabled: map.get(type) ?? true }));
}

export async function setMyPref(ctx: Ctx, type: string, enabled: boolean) {
  if (!(type in NOTIFICATION_TYPES)) throw badRequest('unknown_type', 'Unknown notification type');
  await ctx.tx`insert into core.user_notification_prefs (tenant_id, user_id, type, enabled)
    values (${ctx.tenantId}, ${ctx.actor.userId}, ${type}, ${enabled})
    on conflict (user_id, type) do update set enabled = excluded.enabled`;
}

export async function orgSettings(ctx: Ctx, orgId: string) {
  const out = [];
  for (const [type, t] of Object.entries(NOTIFICATION_TYPES)) {
    const s = await orgSetting(ctx.tx, orgId, type as NotificationType);
    out.push({ type, label: t.label, who: t.who, enabled: s.enabled, config: s.config });
  }
  return out;
}

export async function setOrgSetting(ctx: Ctx, orgId: string, type: string, enabled: boolean, cfg: Record<string, unknown>) {
  requirePerm(ctx, 'settings.manage', orgId);
  if (!(type in NOTIFICATION_TYPES)) throw badRequest('unknown_type', 'Unknown notification type');
  await ctx.tx`insert into core.notification_settings (tenant_id, org_id, type, enabled, config)
    values (${ctx.tenantId}, ${orgId}, ${type}, ${enabled}, ${ctx.tx.json(cfg as never)})
    on conflict (org_id, type) do update set enabled = excluded.enabled, config = excluded.config`;
}

export async function savePushSubscription(ctx: Ctx, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  await ctx.tx`insert into core.push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth)
    values (${ctx.tenantId}, ${ctx.actor.userId}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`;
}

export const pushEnabled = () => Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);

/** Worker: deliver queued notifications as web push to every device the person installed the app on. */
export async function deliverPush(): Promise<number> {
  if (!pushEnabled()) {
    await withSystem((tx) => tx`update core.notifications set pushed_at = now() where pushed_at is null`);
    return 0;
  }
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!);
  const pending = await withSystem((tx) => tx<{ id: string; user_id: string; title: string; body: string; link: string | null }[]>`
    update core.notifications set pushed_at = now()
    where id in (select id from core.notifications where pushed_at is null order by created_at limit 100 for update skip locked)
    returning id, user_id, title, body, link`);
  for (const n of pending) {
    const subs = await withSystem((tx) => tx<{ id: string; endpoint: string; p256dh: string; auth: string }[]>`
      select id, endpoint, p256dh, auth from core.push_subscriptions where user_id = ${n.user_id}`);
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: n.title, body: n.body, link: n.link }), { TTL: 3600 });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await withSystem((tx) => tx`delete from core.push_subscriptions where id = ${s.id}`);
      }
    }
  }
  return pending.length;
}
