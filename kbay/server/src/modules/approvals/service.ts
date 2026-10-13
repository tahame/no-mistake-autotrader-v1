import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { APPROVAL_KINDS, type ApprovalKind } from '../../core/permissions.js';
import type { Tx } from '../../db/db.js';
import { usersWithPermission } from '../identity/index.js';
import { notify, orgSetting } from '../notifications/index.js';

// Modules that own an approvable subject register what happens on approve/reject.
// This keeps approvals independent of finance/orders (no import cycle).
export interface ApprovalHandler {
  onApproved(ctx: Ctx, subjectId: string, approvalId: string): Promise<void>;
  onRejected(ctx: Ctx, subjectId: string, approvalId: string): Promise<void>;
}
const handlers = new Map<string, ApprovalHandler>();
export function registerApprovalHandler(subjectType: string, h: ApprovalHandler) {
  handlers.set(subjectType, h);
}

export interface ApprovalInput {
  orgId: string;
  locationId?: string | null;
  kind: ApprovalKind;
  subjectType: string;
  subjectId: string;
  summary: string;
  amountMinor?: number | null;
}

export async function requestApproval(ctx: Ctx, a: ApprovalInput): Promise<string> {
  const [row] = await ctx.tx<{ id: string }[]>`
    insert into core.approval_requests (tenant_id, org_id, location_id, kind, subject_type, subject_id, summary, amount_minor, requested_by)
    values (${ctx.tenantId}, ${a.orgId}, ${a.locationId ?? null}, ${a.kind}, ${a.subjectType}, ${a.subjectId}, ${a.summary},
      ${a.amountMinor ?? null}, ${ctx.actor.userId})
    returning id`;
  const id = row!.id;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId: a.orgId, actorUserId: ctx.actor.userId, action: 'approval.requested',
    entityType: 'approval', entityId: id, after: a });
  const approvers = (await approversFor(ctx.tx, a.orgId, a.kind, a.locationId)).filter((u) => u !== ctx.actor.userId);
  await notify(ctx.tx, {
    tenantId: ctx.tenantId, orgId: a.orgId, userIds: approvers, type: 'approval_request',
    title: `Approval needed: ${a.summary}`, body: `Requested by ${ctx.actor.displayName}`, link: `/approvals/${id}`,
    dedupeKey: `approval:${id}`,
  });
  return id;
}

export function approversFor(tx: Tx, orgId: string, kind: ApprovalKind, locationId?: string | null) {
  return usersWithPermission(tx, orgId, APPROVAL_KINDS[kind], locationId);
}

export async function decide(ctx: Ctx, approvalId: string, decision: 'approve' | 'reject', note?: string) {
  const [a] = await ctx.tx<{ id: string; org_id: string; location_id: string | null; kind: ApprovalKind; subject_type: string;
    subject_id: string; status: string; requested_by: string; summary: string }[]>`
    select id, org_id, location_id, kind, subject_type, subject_id, status, requested_by, summary
    from core.approval_requests where id = ${approvalId} for update`;
  if (!a) throw notFound('Approval');
  if (a.status !== 'pending') throw conflict('already_decided', 'This request was already decided.');
  if (!ctx.access.can(APPROVAL_KINDS[a.kind], a.org_id, a.location_id)) throw forbidden('You cannot approve this kind of request.');
  if (a.requested_by === ctx.actor.userId) throw forbidden('You cannot approve your own request; another approver must.');
  if (decision === 'reject' && !note?.trim()) throw badRequest('reason_required', 'Give a reason when rejecting.');
  await ctx.tx`update core.approval_requests set status = ${decision === 'approve' ? 'approved' : 'rejected'},
    decided_by = ${ctx.actor.userId}, decided_at = now(), decision_note = ${note ?? null} where id = ${approvalId}`;
  const h = handlers.get(a.subject_type);
  if (!h) throw new Error(`no approval handler for ${a.subject_type}`);
  if (decision === 'approve') await h.onApproved(ctx, a.subject_id, a.id);
  else await h.onRejected(ctx, a.subject_id, a.id);
  if (note?.trim()) {
    await ctx.tx`insert into core.comments (tenant_id, org_id, entity_type, entity_id, author_id, body)
      values (${ctx.tenantId}, ${a.org_id}, 'approval', ${a.id}, ${ctx.actor.userId}, ${note})`;
  }
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId: a.org_id, actorUserId: ctx.actor.userId, action: `approval.${decision}d`,
    entityType: 'approval', entityId: a.id, after: { note } });
  await notify(ctx.tx, {
    tenantId: ctx.tenantId, orgId: a.org_id, userIds: [a.requested_by], type: 'approval_decided',
    title: `${decision === 'approve' ? 'Approved' : 'Rejected'}: ${a.summary}`,
    body: note ? `${ctx.actor.displayName}: ${note}` : `By ${ctx.actor.displayName}`, link: `/approvals/${a.id}`,
  });
}

/** Withdraw your own pending request (e.g. a mistaken entry). */
export async function cancel(ctx: Ctx, approvalId: string) {
  const [a] = await ctx.tx<{ requested_by: string; status: string; subject_type: string; subject_id: string; org_id: string }[]>`
    select requested_by, status, subject_type, subject_id, org_id from core.approval_requests where id = ${approvalId} for update`;
  if (!a) throw notFound('Approval');
  if (a.requested_by !== ctx.actor.userId) throw forbidden('Only the requester can withdraw a request.');
  if (a.status !== 'pending') throw conflict('already_decided', 'This request was already decided.');
  await ctx.tx`update core.approval_requests set status = 'cancelled', decided_at = now(), decided_by = ${ctx.actor.userId} where id = ${approvalId}`;
  await handlers.get(a.subject_type)?.onRejected(ctx, a.subject_id, approvalId);
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId: a.org_id, actorUserId: ctx.actor.userId, action: 'approval.cancelled', entityType: 'approval', entityId: approvalId });
}

export async function list(ctx: Ctx, orgId: string, status: string) {
  const rows = await ctx.tx<{ id: string; kind: ApprovalKind; location_id: string | null; requested_by: string }[]>`
    select a.id, a.kind, a.subject_type, a.subject_id, a.summary, a.amount_minor, a.status, a.location_id, a.requested_by,
           a.requested_at, a.decided_at, a.decision_note, l.name as location_name,
           coalesce(rp.display_name, rp.full_name, ru.username) as requested_by_name,
           coalesce(dp.display_name, dp.full_name, du.username) as decided_by_name,
           (select count(*)::int from core.comments c where c.entity_type = 'approval' and c.entity_id = a.id) as comment_count
    from core.approval_requests a
    left join core.locations l on l.id = a.location_id
    join core.users ru on ru.id = a.requested_by left join core.people rp on rp.id = ru.person_id
    left join core.users du on du.id = a.decided_by left join core.people dp on dp.id = du.person_id
    where a.org_id = ${orgId} and (${status} = 'all' or a.status = ${status})
    order by a.requested_at desc limit 200`;
  return rows.map((r) => ({
    ...r,
    canDecide: r.requested_by !== ctx.actor.userId && ctx.access.can(APPROVAL_KINDS[r.kind], orgId, r.location_id),
  }));
}

export async function get(ctx: Ctx, approvalId: string) {
  const [a] = await ctx.tx`select * from core.approval_requests where id = ${approvalId}`;
  if (!a) throw notFound('Approval');
  return a;
}

/** Worker: persistent follow-ups until actioned — a missed approval holds up the business. */
export async function sendReminders(tx: Tx): Promise<number> {
  const pending = await tx<{ id: string; tenant_id: string; org_id: string; location_id: string | null; kind: ApprovalKind;
    summary: string; requested_by: string; requested_at: Date; last_reminded_at: Date | null; reminder_count: number }[]>`
    select id, tenant_id, org_id, location_id, kind, summary, requested_by, requested_at, last_reminded_at, reminder_count
    from core.approval_requests where status = 'pending'`;
  let sent = 0;
  for (const a of pending) {
    const s = await orgSetting(tx, a.org_id, 'approval_reminder');
    if (!s.enabled) continue;
    const everyMs = Number(s.config.everyHours ?? 2) * 3600_000;
    const last = (a.last_reminded_at ?? a.requested_at).getTime();
    if (Date.now() - last < everyMs) continue;
    const users = (await approversFor(tx, a.org_id, a.kind, a.location_id)).filter((u) => u !== a.requested_by);
    const n = a.reminder_count + 1;
    await notify(tx, { tenantId: a.tenant_id, orgId: a.org_id, userIds: users, type: 'approval_reminder',
      title: `Still waiting (${n}): ${a.summary}`, body: 'This approval is holding up the business.', link: `/approvals/${a.id}`,
      dedupeKey: `approval:${a.id}:r${n}` });
    await tx`update core.approval_requests set last_reminded_at = now(), reminder_count = ${n} where id = ${a.id}`;
    sent++;
  }
  return sent;
}
