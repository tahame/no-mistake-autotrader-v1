import { audit } from '../../core/audit.js';
import { badRequest, forbidden } from '../../core/errors.js';
import type { Tx } from '../../db/db.js';
import { withSystem } from '../../db/db.js';
import type { AuthInfo } from '../identity/index.js';

// The application owner's control room: every tenant, module switches per tenant (plans),
// OTP per tenant, and platform health. Above any single customer's super admin.

export const MODULES = ['pos', 'inventory', 'finance', 'approvals', 'reports', 'investor_portal', 'customer_ordering', 'ai_entry', 'cameras'] as const;

export function requireOwner(auth: AuthInfo) {
  if (!auth.actor.isPlatformOwner) throw forbidden('Owner portal only.');
}

export async function tenants() {
  return withSystem((tx) => tx`
    select t.id, t.slug, t.name, t.active, t.otp_enabled, t.created_at,
      (select count(*)::int from core.organizations o where o.tenant_id = t.id) as orgs,
      (select count(*)::int from core.locations l where l.tenant_id = t.id and l.active) as locations,
      (select count(*)::int from core.users u where u.tenant_id = t.id and u.active) as users,
      coalesce((select json_object_agg(m.module, m.enabled) from core.tenant_modules m where m.tenant_id = t.id), '{}') as modules
    from core.tenants t order by t.created_at`);
}

export async function updateTenant(auth: AuthInfo, tenantId: string, input: { active?: boolean; otpEnabled?: boolean; modules?: Record<string, boolean> }) {
  requireOwner(auth);
  await withSystem(async (tx) => {
    if (input.active !== undefined) await tx`update core.tenants set active = ${input.active} where id = ${tenantId}`;
    if (input.otpEnabled !== undefined) await tx`update core.tenants set otp_enabled = ${input.otpEnabled} where id = ${tenantId}`;
    for (const [module, enabled] of Object.entries(input.modules ?? {})) {
      if (!(MODULES as readonly string[]).includes(module)) throw badRequest('unknown_module', `Unknown module ${module}`);
      await tx`insert into core.tenant_modules (tenant_id, module, enabled) values (${tenantId}, ${module}, ${enabled})
        on conflict (tenant_id, module) do update set enabled = excluded.enabled`;
    }
    await audit(tx, { tenantId, actorUserId: auth.actor.userId, action: 'owner.tenant_updated', entityType: 'tenant', entityId: tenantId, after: input });
  });
}

export async function health() {
  return withSystem(async (tx) => {
    const [db] = await tx<{ now: Date; size: string }[]>`select now(), pg_size_pretty(pg_database_size(current_database())) as size`;
    const [outbox] = await tx<{ pending: number; failing: number; oldest: Date | null }[]>`
      select count(*) filter (where processed_at is null)::int as pending,
             count(*) filter (where processed_at is null and last_error is not null)::int as failing,
             min(created_at) filter (where processed_at is null) as oldest
      from orders.outbox`;
    const [push] = await tx<{ n: number }[]>`select count(*)::int as n from core.notifications where pushed_at is null`;
    const [migr] = await tx<{ name: string }[]>`select name from public.schema_migrations order by name desc limit 1`;
    return { db: { time: db!.now, size: db!.size }, outbox: outbox!, pushQueue: push!.n, schema: migr?.name ?? null, audit: await verifyAuditChain(tx) };
  });
}

/** Recompute the audit hash chain; any edited or removed row breaks it. */
export async function verifyAuditChain(tx: Tx): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
  const rows = await tx<{ id: number; ok: boolean }[]>`
    select id, hash = encode(sha256(convert_to(
      prev_hash || '|' || coalesce(tenant_id::text, '') || '|' || coalesce(actor_user_id::text, '') || '|' ||
      action || '|' || entity_type || '|' || coalesce(entity_id, '') || '|' ||
      coalesce(before::text, '') || '|' || coalesce(after::text, '') || '|' || to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex')
      and prev_hash = coalesce(lag(hash) over (order by id), 'genesis') as ok
    from core.audit_log order by id`;
  const bad = rows.find((r) => !r.ok);
  return { ok: !bad, checked: rows.length, brokenAt: bad?.id ?? null };
}
