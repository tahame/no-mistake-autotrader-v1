import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest } from '../../core/errors.js';
import type { Tx } from '../../db/db.js';
import { notify, orgSetting } from '../notifications/index.js';

// Questions and notes attached to any entry, so the whole conversation stays with the record
// instead of scattered WhatsApp messages.

export async function listComments(ctx: Ctx, entityType: string, entityId: string) {
  return ctx.tx`
    select c.id, c.parent_id, c.body, c.is_question, c.asked_user_id, c.answered_at, c.created_at, c.author_id,
           coalesce(p.display_name, p.full_name, u.username) as author_name,
           coalesce(ap.display_name, ap.full_name, au.username) as asked_name
    from core.comments c join core.users u on u.id = c.author_id left join core.people p on p.id = u.person_id
    left join core.users au on au.id = c.asked_user_id left join core.people ap on ap.id = au.person_id
    where c.entity_type = ${entityType} and c.entity_id = ${entityId}
    order by c.created_at`;
}

export async function addComment(ctx: Ctx, input: { orgId: string; entityType: string; entityId: string; body: string;
  parentId?: string | null; askUserId?: string | null; link?: string }) {
  requirePerm(ctx, 'comment.create', input.orgId);
  if (!input.body.trim()) throw badRequest('empty', 'Write something first.');
  const isQuestion = Boolean(input.askUserId);
  const [c] = await ctx.tx<{ id: string }[]>`
    insert into core.comments (tenant_id, org_id, entity_type, entity_id, parent_id, author_id, body, is_question, asked_user_id)
    values (${ctx.tenantId}, ${input.orgId}, ${input.entityType}, ${input.entityId}, ${input.parentId ?? null}, ${ctx.actor.userId},
      ${input.body.trim()}, ${isQuestion}, ${input.askUserId ?? null})
    returning id`;
  // A reply by the person asked answers the question.
  if (input.parentId) {
    await ctx.tx`update core.comments set answered_at = now()
      where id = ${input.parentId} and is_question and answered_at is null and asked_user_id = ${ctx.actor.userId}`;
  }
  if (isQuestion) {
    await notify(ctx.tx, { tenantId: ctx.tenantId, orgId: input.orgId, userIds: [input.askUserId!], type: 'question_asked',
      title: `${ctx.actor.displayName} asked you a question`, body: input.body.slice(0, 200), link: input.link,
      dedupeKey: `question:${c!.id}` });
  }
  return { id: c!.id };
}

/** Worker: nudge the person asked if a question sits unanswered. */
export async function questionFollowups(tx: Tx): Promise<number> {
  const open = await tx<{ id: string; tenant_id: string; org_id: string; asked_user_id: string; body: string; created_at: Date;
    last_followup_at: Date | null; entity_type: string; entity_id: string }[]>`
    select id, tenant_id, org_id, asked_user_id, body, created_at, last_followup_at, entity_type, entity_id
    from core.comments where is_question and answered_at is null and asked_user_id is not null`;
  let n = 0;
  for (const q of open) {
    const s = await orgSetting(tx, q.org_id, 'question_followup');
    if (!s.enabled) continue;
    const afterMs = Number(s.config.afterHours ?? 24) * 3600_000;
    const last = (q.last_followup_at ?? q.created_at).getTime();
    if (Date.now() - last < afterMs) continue;
    await notify(tx, { tenantId: q.tenant_id, orgId: q.org_id, userIds: [q.asked_user_id], type: 'question_followup',
      title: 'A question is waiting for your answer', body: q.body.slice(0, 200),
      dedupeKey: `question:${q.id}:${new Date().toISOString().slice(0, 13)}` });
    await tx`update core.comments set last_followup_at = now() where id = ${q.id}`;
    n++;
  }
  return n;
}
