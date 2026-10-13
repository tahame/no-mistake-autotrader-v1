import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { allocate } from '../../core/math.js';
import type { Tx } from '../../db/db.js';
import { requestApproval } from '../approvals/index.js';

// Partners hold profit shares as weights (a ratio). Percent = weight / total weight on a date,
// so three equal partners are exactly one third each. Investors may optionally take a return,
// which adds their weight to the split. Every change keeps history; nothing is overwritten.

export interface ShareRow { person_id: string; weight: string; role: 'partner' | 'investor' }

export async function sharesOn(tx: Tx, orgId: string, date: string): Promise<ShareRow[]> {
  return tx<ShareRow[]>`
    select person_id, weight::text as weight, 'partner' as role from finance.partner_shares
      where org_id = ${orgId} and effective_from <= ${date} and (effective_to is null or effective_to >= ${date})
    union all
    select person_id, return_weight::text as weight, 'investor' as role from finance.investor_terms
      where org_id = ${orgId} and takes_return and return_weight > 0
        and effective_from <= ${date} and (effective_to is null or effective_to >= ${date})
    order by person_id`;
}

export async function partnerUserIds(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    select distinct u.id from core.users u join finance.partner_shares s on s.person_id = u.person_id
    where s.org_id = ${orgId} and s.effective_to is null and u.active`;
  return rows.map((r) => r.id);
}

export async function listPartners(ctx: Ctx, orgId: string) {
  requirePerm(ctx, 'reports.partners', orgId);
  const shares = await ctx.tx<{ id: string; person_id: string; name: string; weight: string; effective_from: string; effective_to: string | null }[]>`
    select s.id, s.person_id, coalesce(p.display_name, p.full_name) as name, s.weight::text as weight, s.effective_from, s.effective_to
    from finance.partner_shares s join core.people p on p.id = s.person_id where s.org_id = ${orgId}
    order by s.effective_to nulls first, s.effective_from desc, name`;
  const current = shares.filter((s) => s.effective_to === null);
  const total = current.reduce((a, s) => a + Number(s.weight), 0);
  const investors = await ctx.tx`
    select t.id, t.person_id, coalesce(p.display_name, p.full_name) as name, t.takes_return, t.return_weight::text as return_weight,
           t.mentorship, t.effective_from, t.effective_to
    from finance.investor_terms t join core.people p on p.id = t.person_id where t.org_id = ${orgId}
    order by t.effective_to nulls first, t.effective_from desc`;
  const proposals = await ctx.tx`select id, shares, effective_from, reason, status, created_at from finance.partner_share_proposals
    where org_id = ${orgId} order by created_at desc limit 20`;
  return {
    current: current.map((s) => ({ ...s, percent: total > 0 ? Math.round((Number(s.weight) / total) * 10000) / 100 : 0 })),
    history: shares.filter((s) => s.effective_to !== null),
    investors,
    proposals,
  };
}

/**
 * Propose a new share split (adding a partner, or changing shares). Shares are given as
 * percentages or ratios; the system warns when percentages do not add to 100.
 */
export async function proposeShares(ctx: Ctx, orgId: string, input: { shares: { personId: string; weight: number }[]; effectiveFrom: string;
  reason?: string; mode: 'percent' | 'ratio' }) {
  requirePerm(ctx, 'partners.manage', orgId);
  if (input.shares.length === 0) throw badRequest('no_partners', 'Add at least one partner.');
  const ids = new Set(input.shares.map((s) => s.personId));
  if (ids.size !== input.shares.length) throw badRequest('duplicate_partner', 'Each partner appears once.');
  for (const s of input.shares) if (!(s.weight > 0)) throw badRequest('bad_share', 'Every share must be above zero.');
  const sum = input.shares.reduce((a, s) => a + s.weight, 0);
  // Equal thirds typed as 33.33 add to 99.99; allow a hundredth per partner of rounding.
  if (input.mode === 'percent' && Math.abs(sum - 100) > 0.01 * input.shares.length) {
    throw badRequest('shares_not_100', `Shares add to ${sum.toFixed(2)}%, not 100%.`);
  }
  const [pending] = await ctx.tx`select id from finance.partner_share_proposals where org_id = ${orgId} and status = 'pending_approval'`;
  if (pending) throw conflict('proposal_pending', 'A share change is already waiting for approval.');
  const [p] = await ctx.tx<{ id: string }[]>`insert into finance.partner_share_proposals (tenant_id, org_id, shares, effective_from, reason, created_by)
    values (${ctx.tenantId}, ${orgId}, ${ctx.tx.json(input.shares as never)}, ${input.effectiveFrom}, ${input.reason ?? null}, ${ctx.actor.userId})
    returning id`;
  const names = await ctx.tx<{ id: string; name: string }[]>`select id, coalesce(display_name, full_name) as name from core.people
    where id = any(${[...ids]}::uuid[])`;
  const label = input.shares.map((s) => `${names.find((n) => n.id === s.personId)?.name ?? '?'} ${((s.weight / sum) * 100).toFixed(2)}%`).join(', ');
  const approvalId = await requestApproval(ctx, { orgId, kind: 'partner_change', subjectType: 'share_proposal', subjectId: p!.id,
    summary: `Partner shares from ${input.effectiveFrom}: ${label}` });
  await ctx.tx`update finance.partner_share_proposals set approval_id = ${approvalId} where id = ${p!.id}`;
  return { id: p!.id, approvalId };
}

export async function applyShareProposal(ctx: Ctx, proposalId: string) {
  const [p] = await ctx.tx<{ org_id: string; shares: { personId: string; weight: number }[]; effective_from: string; status: string }[]>`
    select org_id, shares, effective_from, status from finance.partner_share_proposals where id = ${proposalId} for update`;
  if (!p) throw notFound('Proposal');
  if (p.status !== 'pending_approval') return;
  // Close current rows the day before the new split starts; history stays.
  await ctx.tx`update finance.partner_shares set effective_to = (${p.effective_from}::date - 1)
    where org_id = ${p.org_id} and effective_to is null and effective_from < ${p.effective_from}`;
  await ctx.tx`delete from finance.partner_shares where org_id = ${p.org_id} and effective_from >= ${p.effective_from}`;
  for (const s of p.shares) {
    await ctx.tx`insert into finance.partner_shares (tenant_id, org_id, person_id, weight, effective_from, created_by)
      values (${ctx.tenantId}, ${p.org_id}, ${s.personId}, ${s.weight}, ${p.effective_from}, ${ctx.actor.userId})`;
    await ctx.tx`insert into core.person_orgs (tenant_id, person_id, org_id) values (${ctx.tenantId}, ${s.personId}, ${p.org_id}) on conflict do nothing`;
  }
  await ctx.tx`update finance.partner_share_proposals set status = 'applied' where id = ${proposalId}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId: p.org_id, actorUserId: ctx.actor.userId, action: 'partners.shares_applied',
    entityType: 'share_proposal', entityId: proposalId, after: p });
}

export async function rejectShareProposal(ctx: Ctx, proposalId: string) {
  await ctx.tx`update finance.partner_share_proposals set status = 'rejected' where id = ${proposalId} and status = 'pending_approval'`;
}

/** Investor terms per organization: return optional, mentorship optional, changeable with history. */
export async function setInvestorTerms(ctx: Ctx, orgId: string, input: { personId: string; takesReturn: boolean; returnWeight: number;
  mentorship: boolean; effectiveFrom: string }) {
  requirePerm(ctx, 'partners.manage', orgId);
  if (input.takesReturn && !(input.returnWeight > 0)) throw badRequest('bad_share', 'Set the return share when the investor takes a return.');
  await ctx.tx`update finance.investor_terms set effective_to = (${input.effectiveFrom}::date - 1)
    where org_id = ${orgId} and person_id = ${input.personId} and effective_to is null and effective_from < ${input.effectiveFrom}`;
  await ctx.tx`delete from finance.investor_terms where org_id = ${orgId} and person_id = ${input.personId} and effective_from >= ${input.effectiveFrom}`;
  await ctx.tx`insert into finance.investor_terms (tenant_id, org_id, person_id, takes_return, return_weight, mentorship, effective_from, created_by)
    values (${ctx.tenantId}, ${orgId}, ${input.personId}, ${input.takesReturn}, ${input.takesReturn ? input.returnWeight : 0},
      ${input.mentorship}, ${input.effectiveFrom}, ${ctx.actor.userId})`;
  await ctx.tx`insert into core.person_orgs (tenant_id, person_id, org_id) values (${ctx.tenantId}, ${input.personId}, ${orgId}) on conflict do nothing`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'investor.terms_set', entityType: 'person', entityId: input.personId, after: input });
}

/** Net profit per calendar date (revenue - expenses) for the organization. */
async function dailyProfit(tx: Tx, orgId: string, from: string | null, to: string): Promise<{ d: string; profit: number }[]> {
  return tx<{ d: string; profit: number }[]>`
    select e.entry_date as d,
      coalesce(sum(case when la.type = 'revenue' then l.credit_minor - l.debit_minor
                        else l.credit_minor - l.debit_minor end), 0)::bigint as profit
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.ledger_accounts la on la.id = l.ledger_account_id
    where e.org_id = ${orgId} and la.type in ('revenue', 'expense') and e.entry_date <= ${to}
      and (${from}::date is null or e.entry_date >= ${from})
    group by e.entry_date order by e.entry_date`;
}

/** Each person's share of profit over a period, split day by day using the shares in force that day. */
export async function earnedByPerson(tx: Tx, orgId: string, from: string | null, to: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const { d, profit } of await dailyProfit(tx, orgId, from, to)) {
    if (profit === 0) continue;
    const shares = await sharesOn(tx, orgId, d);
    if (shares.length === 0) continue;
    const parts = allocate(profit, shares.map((s) => Number(s.weight)));
    shares.forEach((s, i) => out.set(s.person_id, (out.get(s.person_id) ?? 0) + parts[i]!));
  }
  return out;
}

/**
 * Partner statement: earned (share of profit), withdrawn, reinvested for the period, and how much
 * of each person's profit is still in the business (retained, all time).
 */
export async function partnerStatement(ctx: Ctx, orgId: string, from: string, to: string, onlyPersonId?: string | null) {
  // Anyone may see their own line; seeing everyone's needs reports.partners.
  const ownOnly = Boolean(onlyPersonId && onlyPersonId === ctx.actor.personId);
  if (!ownOnly) requirePerm(ctx, 'reports.partners', orgId);
  const earnedPeriod = await earnedByPerson(ctx.tx, orgId, from, to);
  const earnedAll = await earnedByPerson(ctx.tx, orgId, null, to);
  const flows = await ctx.tx<{ person_id: string; key: string; period: number; all_time: number }[]>`
    select l.person_id, la.system_key as key,
      coalesce(sum(case when e.entry_date >= ${from} then l.debit_minor - l.credit_minor else 0 end), 0)::bigint as period,
      coalesce(sum(l.debit_minor - l.credit_minor), 0)::bigint as all_time
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.ledger_accounts la on la.id = l.ledger_account_id
    where e.org_id = ${orgId} and la.system_key in ('drawings', 'reinvested') and l.person_id is not null and e.entry_date <= ${to}
    group by l.person_id, la.system_key`;
  const people = new Set<string>([...earnedAll.keys(), ...flows.map((f) => f.person_id)]);
  const current = await sharesOn(ctx.tx, orgId, to);
  const names = await ctx.tx<{ id: string; name: string }[]>`select id, coalesce(display_name, full_name) as name from core.people
    where id = any(${[...people, ...current.map((c) => c.person_id)]}::uuid[])`;
  for (const c of current) people.add(c.person_id);
  const totalWeight = current.reduce((a, s) => a + Number(s.weight), 0);
  const get = (pid: string, key: string, f: 'period' | 'all_time') => flows.find((x) => x.person_id === pid && x.key === key)?.[f] ?? 0;
  return [...people].filter((pid) => !onlyPersonId || pid === onlyPersonId).map((pid) => {
    const share = current.find((c) => c.person_id === pid);
    const withdrawnAll = get(pid, 'drawings', 'all_time');
    const reinvestedAll = get(pid, 'reinvested', 'all_time');
    return {
      personId: pid,
      name: names.find((n) => n.id === pid)?.name ?? 'Unknown',
      role: share?.role ?? 'former',
      sharePercent: share && totalWeight > 0 ? Math.round((Number(share.weight) / totalWeight) * 10000) / 100 : 0,
      earnedMinor: earnedPeriod.get(pid) ?? 0,
      withdrawnMinor: get(pid, 'drawings', 'period'),
      reinvestedMinor: get(pid, 'reinvested', 'period'),
      retainedMinor: (earnedAll.get(pid) ?? 0) - withdrawnAll - reinvestedAll,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
