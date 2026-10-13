import type { Tx } from '../db/db.js';

export interface AuditInput {
  tenantId: string | null;
  orgId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** Append to the hash-chained audit trail inside the caller's transaction. */
export async function audit(tx: Tx, a: AuditInput): Promise<void> {
  const actor = a.actorUserId && a.actorUserId !== '00000000-0000-0000-0000-000000000000' ? a.actorUserId : null;
  await tx`
    insert into core.audit_log (tenant_id, org_id, actor_user_id, action, entity_type, entity_id, before, after, ip)
    values (${a.tenantId}, ${a.orgId ?? null}, ${actor}, ${a.action}, ${a.entityType}, ${a.entityId ?? null},
            ${a.before === undefined ? null : tx.json(a.before as never)},
            ${a.after === undefined ? null : tx.json(a.after as never)}, ${a.ip ?? null})`;
}
