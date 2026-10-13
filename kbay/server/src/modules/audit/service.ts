import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';

/** The unchangeable history of who changed what and when. */
export async function listAudit(ctx: Ctx, orgId: string, opts: { entityType?: string | null; entityId?: string | null; action?: string | null; limit?: number }) {
  requirePerm(ctx, 'audit.view', orgId);
  return ctx.tx`
    select a.id, a.at, a.action, a.entity_type, a.entity_id, a.before, a.after, a.ip,
      coalesce(p.display_name, p.full_name, u.username, 'system') as actor
    from core.audit_log a left join core.users u on u.id = a.actor_user_id left join core.people p on p.id = u.person_id
    where (a.org_id = ${orgId} or a.org_id is null)
      and (${opts.entityType ?? null}::text is null or a.entity_type = ${opts.entityType ?? null})
      and (${opts.entityId ?? null}::text is null or a.entity_id = ${opts.entityId ?? null})
      and (${opts.action ?? null}::text is null or a.action like ${(opts.action ?? '') + '%'})
    order by a.id desc limit ${Math.min(opts.limit ?? 200, 1000)}`;
}
