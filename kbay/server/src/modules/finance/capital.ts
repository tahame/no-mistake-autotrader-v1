import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { requestApproval } from '../approvals/index.js';
import { accountId, postEntry } from '../ledger/index.js';
import { notify } from '../notifications/index.js';
import { assertLocationInOrg, getOrg, localDate, personUserId } from '../tenancy/index.js';
import { moneyAccount } from './accounts.js';
import { partnerUserIds } from './partners.js';

// Capital is kept completely separate from profit. Investment is placed per stall (or at org
// level); loans can convert to investment or be refunded (approval + lender confirms receipt);
// withdrawals need approval and notify every partner; borrowing (advances) is tracked per person.

type Kind = 'investment' | 'loan_in' | 'loan_convert' | 'loan_refund' | 'withdrawal' | 'reinvest' | 'advance' | 'advance_repay';
const fmt = (minor: number) => `Rs ${(minor / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;

function positive(n: number) {
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest('bad_amount', 'Amount must be above zero.');
}

async function personName(ctx: Ctx, personId: string) {
  const [p] = await ctx.tx<{ name: string }[]>`select coalesce(display_name, full_name) as name from core.people where id = ${personId}`;
  if (!p) throw notFound('Person');
  return p.name;
}

async function insertTxn(ctx: Ctx, orgId: string, t: { personId: string; kind: Kind; amountMinor: number; moneyAccountId?: string | null;
  locationId?: string | null; loanId?: string | null; reason?: string | null; status: string; journalEntryId?: string | null }) {
  const [r] = await ctx.tx<{ id: string }[]>`insert into finance.capital_txns (tenant_id, org_id, location_id, person_id, kind, amount_minor,
      money_account_id, loan_id, reason, status, journal_entry_id, created_by)
    values (${ctx.tenantId}, ${orgId}, ${t.locationId ?? null}, ${t.personId}, ${t.kind}, ${t.amountMinor}, ${t.moneyAccountId ?? null},
      ${t.loanId ?? null}, ${t.reason ?? null}, ${t.status}, ${t.journalEntryId ?? null}, ${ctx.actor.userId}) returning id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: `capital.${t.kind}`, entityType: 'capital_txn', entityId: r!.id, after: t });
  return r!.id;
}

async function entry(ctx: Ctx, orgId: string, locationId: string | null | undefined, memo: string, sourceId: string, lines: Parameters<typeof postEntry>[1]['lines']) {
  const org = await getOrg(ctx.tx, orgId);
  return postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: locationId ?? null, entryDate: localDate(org.timezone), memo,
    sourceType: 'capital', sourceId, createdBy: ctx.actor.userId, lines });
}

/** Investment (initial or top-up) into a specific stall, or at organization level. */
export async function recordInvestment(ctx: Ctx, orgId: string, input: { personId: string; amountMinor: number; moneyAccountId: string;
  locationId?: string | null; reason?: string }) {
  requirePerm(ctx, 'capital.manage', orgId);
  positive(input.amountMinor);
  if (input.locationId) await assertLocationInOrg(ctx.tx, orgId, input.locationId);
  const acct = await moneyAccount(ctx.tx, orgId, input.moneyAccountId);
  const id = await insertTxn(ctx, orgId, { ...input, kind: 'investment', status: 'posted' });
  const name = await personName(ctx, input.personId);
  const je = await entry(ctx, orgId, input.locationId, `Investment by ${name}`, id, [
    { account: acct.ledger_account_id, debit: input.amountMinor, moneyAccountId: acct.id },
    { account: await accountId(ctx.tx, orgId, 'capital'), credit: input.amountMinor, personId: input.personId, locationId: input.locationId ?? null },
  ]);
  await ctx.tx`update finance.capital_txns set journal_entry_id = ${je} where id = ${id}`;
  return { id };
}

export async function recordLoan(ctx: Ctx, orgId: string, input: { personId: string; amountMinor: number; moneyAccountId: string;
  dueDate?: string | null; locationId?: string | null; reason?: string }) {
  requirePerm(ctx, 'capital.manage', orgId);
  positive(input.amountMinor);
  const acct = await moneyAccount(ctx.tx, orgId, input.moneyAccountId);
  const [loan] = await ctx.tx<{ id: string }[]>`insert into finance.loans (tenant_id, org_id, location_id, person_id, principal_minor, due_date, note, created_by)
    values (${ctx.tenantId}, ${orgId}, ${input.locationId ?? null}, ${input.personId}, ${input.amountMinor}, ${input.dueDate ?? null},
      ${input.reason ?? null}, ${ctx.actor.userId}) returning id`;
  const id = await insertTxn(ctx, orgId, { ...input, kind: 'loan_in', loanId: loan!.id, status: 'posted' });
  const name = await personName(ctx, input.personId);
  const je = await entry(ctx, orgId, input.locationId, `Loan from ${name}${input.dueDate ? `, due ${input.dueDate}` : ''}`, id, [
    { account: acct.ledger_account_id, debit: input.amountMinor, moneyAccountId: acct.id },
    { account: await accountId(ctx.tx, orgId, 'loans'), credit: input.amountMinor, personId: input.personId },
  ]);
  await ctx.tx`update finance.capital_txns set journal_entry_id = ${je} where id = ${id}`;
  return { id: loan!.id };
}

/** Outstanding = principal - converted - refunded (confirmed) - refunds in progress. */
export async function loanPosition(ctx: Ctx, loanId: string) {
  const [l] = await ctx.tx<{ id: string; org_id: string; person_id: string; location_id: string | null; principal_minor: number; status: string; due_date: string | null }[]>`
    select id, org_id, person_id, location_id, principal_minor, status, due_date from finance.loans where id = ${loanId} for update`;
  if (!l) throw notFound('Loan');
  const [s] = await ctx.tx<{ converted: number; refunded: number; in_progress: number }[]>`
    select coalesce(sum(case when kind = 'loan_convert' and status = 'posted' then amount_minor end), 0)::bigint as converted,
           coalesce(sum(case when kind = 'loan_refund' and status = 'posted' then amount_minor end), 0)::bigint as refunded,
           coalesce(sum(case when kind = 'loan_refund' and status in ('pending_approval', 'awaiting_confirmation') then amount_minor end), 0)::bigint as in_progress
    from finance.capital_txns where loan_id = ${loanId}`;
  return { ...l, ...s!, outstanding: l.principal_minor - s!.converted - s!.refunded, available: l.principal_minor - s!.converted - s!.refunded - s!.in_progress };
}

/** Part of a loan was spent on the business: it becomes investment, with the date and reason logged. */
export async function convertLoan(ctx: Ctx, orgId: string, loanId: string, input: { amountMinor: number; reason: string }) {
  requirePerm(ctx, 'capital.manage', orgId);
  positive(input.amountMinor);
  if (!input.reason?.trim()) throw badRequest('reason_required', 'Say why the loan money became investment.');
  const pos = await loanPosition(ctx, loanId);
  if (pos.org_id !== orgId) throw notFound('Loan');
  if (input.amountMinor > pos.available) throw conflict('exceeds_loan', `Only ${fmt(pos.available)} of this loan is still open.`);
  const id = await insertTxn(ctx, orgId, { personId: pos.person_id, kind: 'loan_convert', amountMinor: input.amountMinor, loanId,
    locationId: pos.location_id, reason: input.reason, status: 'posted' });
  const je = await entry(ctx, orgId, pos.location_id, `Loan converted to investment: ${input.reason}`, id, [
    { account: await accountId(ctx.tx, orgId, 'loans'), debit: input.amountMinor, personId: pos.person_id },
    { account: await accountId(ctx.tx, orgId, 'capital'), credit: input.amountMinor, personId: pos.person_id, locationId: pos.location_id },
  ]);
  await ctx.tx`update finance.capital_txns set journal_entry_id = ${je} where id = ${id}`;
  await closeLoanIfDone(ctx, loanId);
  return { id };
}

export async function requestLoanRefund(ctx: Ctx, orgId: string, loanId: string, input: { amountMinor: number; moneyAccountId: string; reason?: string }) {
  requirePerm(ctx, 'capital.manage', orgId);
  positive(input.amountMinor);
  const pos = await loanPosition(ctx, loanId);
  if (pos.org_id !== orgId) throw notFound('Loan');
  if (input.amountMinor > pos.available) throw conflict('exceeds_loan', `Only ${fmt(pos.available)} of this loan is still open.`);
  await moneyAccount(ctx.tx, orgId, input.moneyAccountId);
  const id = await insertTxn(ctx, orgId, { personId: pos.person_id, kind: 'loan_refund', amountMinor: input.amountMinor, loanId,
    moneyAccountId: input.moneyAccountId, locationId: pos.location_id, reason: input.reason, status: 'pending_approval' });
  const name = await personName(ctx, pos.person_id);
  const approvalId = await requestApproval(ctx, { orgId, locationId: pos.location_id, kind: 'loan_refund', subjectType: 'capital_txn', subjectId: id,
    summary: `Refund ${fmt(input.amountMinor)} of loan to ${name}`, amountMinor: input.amountMinor });
  await ctx.tx`update finance.capital_txns set approval_id = ${approvalId} where id = ${id}`;
  return { id, approvalId };
}

/** Only the lender can mark a refund as received; until then it is not closed. */
export async function confirmLoanRefund(ctx: Ctx, orgId: string, txnId: string) {
  const [t] = await ctx.tx<{ person_id: string; amount_minor: number; money_account_id: string; loan_id: string; status: string; location_id: string | null }[]>`
    select person_id, amount_minor, money_account_id, loan_id, status, location_id from finance.capital_txns
    where id = ${txnId} and org_id = ${orgId} and kind = 'loan_refund' for update`;
  if (!t) throw notFound('Refund');
  if (t.status !== 'awaiting_confirmation') throw conflict('not_awaiting', 'This refund is not waiting for confirmation.');
  if (ctx.actor.personId !== t.person_id) throw forbidden('Only the person who lent the money can confirm they received it.');
  const acct = await moneyAccount(ctx.tx, orgId, t.money_account_id);
  const name = await personName(ctx, t.person_id);
  const je = await entry(ctx, orgId, t.location_id, `Loan refunded to ${name} (confirmed received)`, txnId, [
    { account: await accountId(ctx.tx, orgId, 'loans'), debit: t.amount_minor, personId: t.person_id },
    { account: acct.ledger_account_id, credit: t.amount_minor, moneyAccountId: acct.id },
  ]);
  await ctx.tx`update finance.capital_txns set status = 'posted', journal_entry_id = ${je}, confirmed_by = ${ctx.actor.userId}, confirmed_at = now()
    where id = ${txnId}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'capital.loan_refund_confirmed', entityType: 'capital_txn', entityId: txnId });
  await closeLoanIfDone(ctx, t.loan_id);
}

async function closeLoanIfDone(ctx: Ctx, loanId: string) {
  const pos = await loanPosition(ctx, loanId);
  if (pos.outstanding <= 0) await ctx.tx`update finance.loans set status = 'closed' where id = ${loanId}`;
}

/** A partner (or investor) taking money out — needs approval; everyone is told when it is paid. */
export async function requestWithdrawal(ctx: Ctx, orgId: string, input: { personId: string; amountMinor: number; moneyAccountId: string;
  locationId?: string | null; reason?: string }) {
  requirePerm(ctx, 'capital.withdraw', orgId);
  positive(input.amountMinor);
  await moneyAccount(ctx.tx, orgId, input.moneyAccountId);
  const id = await insertTxn(ctx, orgId, { ...input, kind: 'withdrawal', status: 'pending_approval' });
  const name = await personName(ctx, input.personId);
  const approvalId = await requestApproval(ctx, { orgId, locationId: input.locationId, kind: 'withdrawal', subjectType: 'capital_txn', subjectId: id,
    summary: `Payout ${fmt(input.amountMinor)} to ${name}${input.reason ? ` — ${input.reason}` : ''}`, amountMinor: input.amountMinor });
  await ctx.tx`update finance.capital_txns set approval_id = ${approvalId} where id = ${id}`;
  return { id, approvalId };
}

/** Keep profit in the business as investment instead of taking it out. */
export async function reinvest(ctx: Ctx, orgId: string, input: { personId: string; amountMinor: number; locationId?: string | null; reason?: string }) {
  requirePerm(ctx, 'capital.manage', orgId);
  positive(input.amountMinor);
  const id = await insertTxn(ctx, orgId, { ...input, kind: 'reinvest', status: 'posted' });
  const name = await personName(ctx, input.personId);
  const je = await entry(ctx, orgId, input.locationId, `${name} reinvested profit share`, id, [
    { account: await accountId(ctx.tx, orgId, 'reinvested'), debit: input.amountMinor, personId: input.personId },
    { account: await accountId(ctx.tx, orgId, 'capital'), credit: input.amountMinor, personId: input.personId, locationId: input.locationId ?? null },
  ]);
  await ctx.tx`update finance.capital_txns set journal_entry_id = ${je} where id = ${id}`;
  return { id };
}

/** Borrowing: someone takes money from the business (advance), or pays it back. */
export async function recordAdvance(ctx: Ctx, orgId: string, input: { personId: string; amountMinor: number; moneyAccountId: string;
  direction: 'take' | 'repay'; reason?: string }) {
  requirePerm(ctx, 'capital.manage', orgId);
  positive(input.amountMinor);
  const acct = await moneyAccount(ctx.tx, orgId, input.moneyAccountId);
  const adv = await accountId(ctx.tx, orgId, 'advances');
  const kind = input.direction === 'take' ? 'advance' : 'advance_repay';
  const id = await insertTxn(ctx, orgId, { ...input, kind, status: 'posted' });
  const name = await personName(ctx, input.personId);
  const je = await entry(ctx, orgId, null, input.direction === 'take' ? `${name} borrowed from ${acct.name}` : `${name} repaid into ${acct.name}`, id,
    input.direction === 'take'
      ? [{ account: adv, debit: input.amountMinor, personId: input.personId }, { account: acct.ledger_account_id, credit: input.amountMinor, moneyAccountId: acct.id }]
      : [{ account: acct.ledger_account_id, debit: input.amountMinor, moneyAccountId: acct.id }, { account: adv, credit: input.amountMinor, personId: input.personId }]);
  await ctx.tx`update finance.capital_txns set journal_entry_id = ${je} where id = ${id}`;
  return { id };
}

// ---- Approval outcomes for capital transactions (withdrawals, loan refunds) ----

export async function onCapitalApproved(ctx: Ctx, txnId: string) {
  const [t] = await ctx.tx<{ org_id: string; kind: Kind; person_id: string; amount_minor: number; money_account_id: string; location_id: string | null;
    reason: string | null; status: string }[]>`
    select org_id, kind, person_id, amount_minor, money_account_id, location_id, reason, status from finance.capital_txns where id = ${txnId} for update`;
  if (!t || t.status !== 'pending_approval') return;
  const name = await personName(ctx, t.person_id);
  if (t.kind === 'withdrawal') {
    const acct = await moneyAccount(ctx.tx, t.org_id, t.money_account_id);
    const je = await entry(ctx, t.org_id, t.location_id, `Payout to ${name}${t.reason ? ` — ${t.reason}` : ''}`, txnId, [
      { account: await accountId(ctx.tx, t.org_id, 'drawings'), debit: t.amount_minor, personId: t.person_id },
      { account: acct.ledger_account_id, credit: t.amount_minor, moneyAccountId: acct.id },
    ]);
    await ctx.tx`update finance.capital_txns set status = 'posted', journal_entry_id = ${je} where id = ${txnId}`;
    await notify(ctx.tx, { tenantId: ctx.tenantId, orgId: t.org_id, userIds: await partnerUserIds(ctx.tx, t.org_id), type: 'payout_made',
      title: `Payout made: ${fmt(t.amount_minor)} to ${name}`, body: `From ${acct.name}`, link: '/money/partners', dedupeKey: `payout:${txnId}` });
  } else if (t.kind === 'loan_refund') {
    await ctx.tx`update finance.capital_txns set status = 'awaiting_confirmation' where id = ${txnId}`;
    const lender = await personUserId(ctx.tx, t.person_id);
    if (lender) {
      await notify(ctx.tx, { tenantId: ctx.tenantId, orgId: t.org_id, userIds: [lender], type: 'loan_refund_confirm',
        title: `Confirm you received ${fmt(t.amount_minor)}`, body: 'The loan refund is only closed once you confirm receipt.',
        link: '/money/capital', dedupeKey: `loanrefund:${txnId}` });
    }
  }
}

export async function onCapitalRejected(ctx: Ctx, txnId: string) {
  await ctx.tx`update finance.capital_txns set status = 'rejected' where id = ${txnId} and status = 'pending_approval'`;
}

export async function listCapital(ctx: Ctx, orgId: string, personId?: string | null) {
  if (!(personId && ctx.actor.personId === personId)) requirePerm(ctx, 'reports.partners', orgId);
  const txns = await ctx.tx`
    select t.id, t.kind, t.amount_minor, t.status, t.reason, t.created_at, t.confirmed_at, t.loan_id, t.person_id,
      coalesce(p.display_name, p.full_name) as person_name, l.name as location_name, m.name as account_name
    from finance.capital_txns t join core.people p on p.id = t.person_id left join core.locations l on l.id = t.location_id
    left join finance.money_accounts m on m.id = t.money_account_id
    where t.org_id = ${orgId} and (${personId ?? null}::uuid is null or t.person_id = ${personId ?? null})
    order by t.created_at desc limit 300`;
  const loans = await ctx.tx<{ id: string }[]>`select l.id, l.person_id, coalesce(p.display_name, p.full_name) as person_name, l.principal_minor,
      l.due_date, l.status, l.created_at, l.note, lo.name as location_name
    from finance.loans l join core.people p on p.id = l.person_id left join core.locations lo on lo.id = l.location_id
    where l.org_id = ${orgId} and (${personId ?? null}::uuid is null or l.person_id = ${personId ?? null}) order by l.created_at desc`;
  const withPos = [];
  for (const l of loans) withPos.push({ ...l, ...(await loanPosition(ctx, l.id)) });
  return { txns, loans: withPos };
}

/** Per person: capital invested (by stall), loans outstanding, advances owed. */
export async function capitalPositions(ctx: Ctx, orgId: string, personId?: string | null) {
  if (!(personId && ctx.actor.personId === personId)) requirePerm(ctx, 'reports.partners', orgId);
  return ctx.tx`
    select l.person_id, coalesce(p.display_name, p.full_name) as person_name, la.system_key as key, l.location_id, lo.name as location_name,
      sum(l.credit_minor - l.debit_minor)::bigint as balance_minor
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.ledger_accounts la on la.id = l.ledger_account_id join core.people p on p.id = l.person_id
    left join core.locations lo on lo.id = l.location_id
    where e.org_id = ${orgId} and la.system_key in ('capital', 'loans', 'advances', 'drawings', 'reinvested')
      and (${personId ?? null}::uuid is null or l.person_id = ${personId ?? null})
    group by l.person_id, person_name, la.system_key, l.location_id, lo.name order by person_name, key, location_name nulls first`;
}
