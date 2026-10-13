import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { applyBps } from '../../core/math.js';
import type { Tx } from '../../db/db.js';
import { requestApproval } from '../approvals/index.js';
import { accountId, postEntry } from '../ledger/index.js';
import { notify } from '../notifications/index.js';
import { assertLocationInOrg, getOrg, localDate } from '../tenancy/index.js';
import { moneyAccount, transfer } from './accounts.js';
import { partnerUserIds } from './partners.js';

// The business day: open (float + stock check) -> sell/spend -> submit close -> partner approves -> locked.

export interface DayRow {
  id: string;
  org_id: string;
  location_id: string;
  business_date: string;
  status: 'open' | 'submitted' | 'approved';
  opening_float_minor: number;
  float_account_id: string;
  opened_at: Date;
  submitted_at: Date | null;
  approved_at: Date | null;
}

/** Checks other modules register (e.g. orders: all sales events processed) before a close is allowed. */
type CloseGuard = (tx: Tx, dayId: string) => Promise<string | null>;
const closeGuards: CloseGuard[] = [];
export const addCloseGuard = (g: CloseGuard) => closeGuards.push(g);

export async function openDayFor(tx: Tx, locationId: string): Promise<DayRow | null> {
  const [d] = await tx<DayRow[]>`select * from finance.business_days where location_id = ${locationId} and status = 'open'`;
  return d ?? null;
}

export async function getDay(tx: Tx, orgId: string, dayId: string): Promise<DayRow> {
  const [d] = await tx<DayRow[]>`select * from finance.business_days where id = ${dayId} and org_id = ${orgId}`;
  if (!d) throw notFound('Business day');
  return d;
}

export type FloatSource = { kind: 'account'; accountId: string } | { kind: 'investment'; personId: string };

export async function openDay(ctx: Ctx, orgId: string, input: { locationId: string; openingFloatMinor: number; floatAccountId?: string;
  /** Where extra float came from (or leftover went to) when the drawer differs from the books. */
  floatSource?: FloatSource | null; note?: string }) {
  requirePerm(ctx, 'day.open', orgId, input.locationId);
  await assertLocationInOrg(ctx.tx, orgId, input.locationId);
  if (!Number.isSafeInteger(input.openingFloatMinor) || input.openingFloatMinor < 0) throw badRequest('bad_amount', 'Enter the float in the drawer.');
  if (await openDayFor(ctx.tx, input.locationId)) throw conflict('day_open', 'This location already has an open day.');
  const org = await getOrg(ctx.tx, orgId);
  const date = localDate(org.timezone);
  const [existing] = await ctx.tx`select id from finance.business_days where location_id = ${input.locationId} and business_date = ${date}`;
  if (existing) throw conflict('day_exists', `The day for ${date} was already opened and closed here.`);
  let floatAccount = input.floatAccountId;
  if (!floatAccount) {
    const [cash] = await ctx.tx<{ id: string }[]>`select id from finance.money_accounts
      where org_id = ${orgId} and location_id = ${input.locationId} and kind = 'cash' and active order by created_at limit 1`;
    if (!cash) throw badRequest('no_cash_account', 'This location has no cash drawer account.');
    floatAccount = cash.id;
  }
  const drawer = await moneyAccount(ctx.tx, orgId, floatAccount);
  const [d] = await ctx.tx<{ id: string }[]>`insert into finance.business_days (tenant_id, org_id, location_id, business_date,
      opening_float_minor, float_account_id, opening_note, opened_by)
    values (${ctx.tenantId}, ${orgId}, ${input.locationId}, ${date}, ${input.openingFloatMinor}, ${floatAccount}, ${input.note ?? null}, ${ctx.actor.userId})
    returning id`;
  // The float counted into the drawer must match the books, or the cash-up can never balance.
  // A difference is either money brought from / sent to a named account, or booked as over/short.
  const [bal] = await ctx.tx<{ v: number }[]>`select coalesce(sum(debit_minor - credit_minor), 0)::bigint as v
    from finance.journal_lines where ledger_account_id = ${drawer.ledger_account_id}`;
  const diff = input.openingFloatMinor - bal!.v;
  if (diff !== 0) {
    const src = input.floatSource;
    if (src?.kind === 'account') {
      await transfer(ctx, orgId, diff > 0
        ? { fromAccountId: src.accountId, toAccountId: drawer.id, amountMinor: diff, note: 'Opening float', locationId: input.locationId, businessDayId: d!.id }
        : { fromAccountId: drawer.id, toAccountId: src.accountId, amountMinor: -diff, note: 'Opening float', locationId: input.locationId, businessDayId: d!.id },
        { skipPermission: true });
    } else if (src?.kind === 'investment' && diff > 0) {
      // Cash put into the drawer by a person is capital invested in this stall.
      const [t] = await ctx.tx<{ id: string }[]>`insert into finance.capital_txns (tenant_id, org_id, location_id, person_id, kind, amount_minor,
          money_account_id, reason, status, created_by)
        values (${ctx.tenantId}, ${orgId}, ${input.locationId}, ${src.personId}, 'investment', ${diff}, ${drawer.id}, 'Opening float', 'posted', ${ctx.actor.userId})
        returning id`;
      const je = await postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: input.locationId, businessDayId: d!.id, entryDate: date,
        memo: 'Opening float invested', sourceType: 'capital', sourceId: t!.id, createdBy: ctx.actor.userId,
        lines: [{ account: drawer.ledger_account_id, debit: diff, moneyAccountId: drawer.id },
          { account: await accountId(ctx.tx, orgId, 'capital'), credit: diff, personId: src.personId, locationId: input.locationId }] });
      await ctx.tx`update finance.capital_txns set journal_entry_id = ${je} where id = ${t!.id}`;
    } else {
      const overShort = await accountId(ctx.tx, orgId, 'cash_over_short');
      await postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: input.locationId, businessDayId: d!.id, entryDate: date,
        memo: `Opening float differs from books: ${drawer.name}`, sourceType: 'float_variance', sourceId: d!.id, createdBy: ctx.actor.userId,
        lines: diff > 0
          ? [{ account: drawer.ledger_account_id, debit: diff, moneyAccountId: drawer.id }, { account: overShort, credit: diff }]
          : [{ account: overShort, debit: -diff }, { account: drawer.ledger_account_id, credit: -diff, moneyAccountId: drawer.id }] });
    }
  }
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'day.opened', entityType: 'business_day', entityId: d!.id, after: input });
  return { id: d!.id, businessDate: date };
}

/** What the books say is in a location's cash drawer right now (shown when opening the day). */
export async function drawerBalance(tx: Tx, orgId: string, locationId: string) {
  const [r] = await tx<{ id: string; name: string; balance: number }[]>`
    select m.id, m.name, coalesce((select sum(debit_minor - credit_minor) from finance.journal_lines l where l.ledger_account_id = m.ledger_account_id), 0)::bigint as balance
    from finance.money_accounts m where m.org_id = ${orgId} and m.location_id = ${locationId} and m.kind = 'cash' and m.active order by m.created_at limit 1`;
  return r ?? null;
}

/** Money summary of a day, straight from the ledger. */
export async function dayFigures(tx: Tx, dayId: string) {
  const [f] = await tx<{ sales: number; refunds: number; cogs: number; waste: number; other_expenses: number; revenue: number; expenses: number }[]>`
    select
      coalesce(sum(case when la.system_key = 'sales' then l.credit_minor - l.debit_minor end), 0)::bigint as sales,
      coalesce(sum(case when la.system_key = 'sales_returns' then l.debit_minor - l.credit_minor end), 0)::bigint as refunds,
      coalesce(sum(case when la.system_key in ('cogs_food', 'cogs_beverage', 'cogs_packaging', 'cogs_fuel') then l.debit_minor - l.credit_minor end), 0)::bigint as cogs,
      coalesce(sum(case when la.system_key in ('waste_food', 'waste_beverage', 'waste_other') then l.debit_minor - l.credit_minor end), 0)::bigint as waste,
      coalesce(sum(case when la.type = 'expense' and (la.system_key is null or la.system_key not in
        ('cogs_food', 'cogs_beverage', 'cogs_packaging', 'cogs_fuel', 'waste_food', 'waste_beverage', 'waste_other')) then l.debit_minor - l.credit_minor end), 0)::bigint as other_expenses,
      coalesce(sum(case when la.type = 'revenue' then l.credit_minor - l.debit_minor end), 0)::bigint as revenue,
      coalesce(sum(case when la.type = 'expense' then l.debit_minor - l.credit_minor end), 0)::bigint as expenses
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.ledger_accounts la on la.id = l.ledger_account_id
    where e.business_day_id = ${dayId}`;
  const flows = await tx<{ money_account_id: string; name: string; kind: string; in_minor: number; out_minor: number }[]>`
    select m.id as money_account_id, m.name, m.kind,
      coalesce(sum(l.debit_minor), 0)::bigint as in_minor, coalesce(sum(l.credit_minor), 0)::bigint as out_minor
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.money_accounts m on m.ledger_account_id = l.ledger_account_id
    where e.business_day_id = ${dayId} group by m.id, m.name, m.kind order by m.kind, m.name`;
  return { ...f!, profit: f!.revenue - f!.expenses, flows };
}

/**
 * What the books expect at close. Cash drawers: the full business balance in the drawer
 * (float + cash taken - cash paid out). Wallets/banks: the net amount that moved through them
 * today, since a personal wallet also holds the owner's own money.
 */
export async function expectedAtClose(tx: Tx, day: DayRow) {
  const accounts = await tx<{ id: string; name: string; kind: string; ledger_account_id: string }[]>`
    select distinct m.id, m.name, m.kind, m.ledger_account_id from finance.money_accounts m
    where m.org_id = ${day.org_id} and (
      (m.location_id = ${day.location_id} and m.active) or m.id = ${day.float_account_id}
      or exists (select 1 from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
                 where e.business_day_id = ${day.id} and l.ledger_account_id = m.ledger_account_id))
    order by m.kind, m.name`;
  const out = [];
  for (const a of accounts) {
    const [r] = a.kind === 'cash'
      ? await tx<{ v: number }[]>`select coalesce(sum(debit_minor - credit_minor), 0)::bigint as v from finance.journal_lines
          where ledger_account_id = ${a.ledger_account_id}`
      : await tx<{ v: number }[]>`select coalesce(sum(l.debit_minor - l.credit_minor), 0)::bigint as v
          from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
          where l.ledger_account_id = ${a.ledger_account_id} and e.business_day_id = ${day.id}`;
    out.push({ moneyAccountId: a.id, name: a.name, kind: a.kind, expectedMinor: r!.v, mode: a.kind === 'cash' ? 'count' : 'confirm' });
  }
  return out;
}

export async function closePreview(ctx: Ctx, orgId: string, dayId: string) {
  const day = await getDay(ctx.tx, orgId, dayId);
  requirePerm(ctx, 'day.close', orgId, day.location_id);
  const problems: string[] = [];
  for (const g of closeGuards) {
    const p = await g(ctx.tx, dayId);
    if (p) problems.push(p);
  }
  const pending = await pendingSpends(ctx.tx, dayId);
  if (pending > 0) problems.push(`${pending} spend(s) for this day are still waiting for approval.`);
  return { day, figures: await dayFigures(ctx.tx, dayId), expected: await expectedAtClose(ctx.tx, day), problems };
}

async function pendingSpends(tx: Tx, dayId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`select
    ((select count(*) from finance.expenses where business_day_id = ${dayId} and status = 'pending_approval') +
     (select count(*) from finance.purchases where business_day_id = ${dayId} and status = 'pending_approval'))::int as n`;
  return r!.n;
}

export async function submitClose(ctx: Ctx, orgId: string, dayId: string, input: {
  declared: { moneyAccountId: string; declaredMinor: number }[];
  transfers: { fromAccountId: string; toAccountId: string; amountMinor: number; note?: string }[];
  note?: string;
}) {
  const day = await getDay(ctx.tx, orgId, dayId);
  requirePerm(ctx, 'day.close', orgId, day.location_id);
  await ctx.tx`select id from finance.business_days where id = ${dayId} for update`;
  if (day.status !== 'open') throw conflict('not_open', 'This day is not open.');
  for (const g of closeGuards) {
    const p = await g(ctx.tx, dayId);
    if (p) throw conflict('close_blocked', p);
  }
  if ((await pendingSpends(ctx.tx, dayId)) > 0) throw conflict('pending_spends', 'Some spends for today still need approval. Get them approved or rejected first.');
  // Money moved at close (e.g. cash deposited to a bank account) is recorded first.
  for (const t of input.transfers) {
    await transfer(ctx, orgId, { ...t, locationId: day.location_id, businessDayId: dayId });
  }
  const expected = await expectedAtClose(ctx.tx, day);
  const declared = new Map(input.declared.map((d) => [d.moneyAccountId, d.declaredMinor]));
  let shortTotal = 0;
  for (const e of expected) {
    const dec = declared.get(e.moneyAccountId);
    if (e.mode === 'count' && dec === undefined) throw badRequest('count_required', `Count the cash in ${e.name}.`);
    const value = dec ?? e.expectedMinor;
    if (!Number.isSafeInteger(value)) throw badRequest('bad_amount', 'Amounts must be whole numbers.');
    shortTotal += value - e.expectedMinor;
    await ctx.tx`insert into finance.day_close_lines (tenant_id, business_day_id, money_account_id, expected_minor, declared_minor)
      values (${ctx.tenantId}, ${dayId}, ${e.moneyAccountId}, ${e.expectedMinor}, ${value})
      on conflict (business_day_id, money_account_id) do update set expected_minor = excluded.expected_minor, declared_minor = excluded.declared_minor`;
  }
  await ctx.tx`update finance.business_days set status = 'submitted', submitted_by = ${ctx.actor.userId}, submitted_at = now(),
    closing_note = ${input.note ?? null} where id = ${dayId}`;
  const figures = await dayFigures(ctx.tx, dayId);
  const [loc] = await ctx.tx<{ name: string }[]>`select name from core.locations where id = ${day.location_id}`;
  const diffText = shortTotal === 0 ? 'cash matches' : shortTotal < 0 ? `short ${fmt(-shortTotal)}` : `over ${fmt(shortTotal)}`;
  await requestApproval(ctx, { orgId, locationId: day.location_id, kind: 'day_close', subjectType: 'business_day', subjectId: dayId,
    summary: `Close ${loc!.name} ${day.business_date}: sales ${fmt(figures.sales)}, ${diffText}`, amountMinor: figures.sales });
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'day.close_submitted', entityType: 'business_day',
    entityId: dayId, after: { declared: input.declared, transfers: input.transfers, figures } });
  return { figures, differenceMinor: shortTotal };
}

const fmt = (minor: number) => `Rs ${(minor / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;

/** On approval: book any cash over/short, accrue sales commission, lock the day, send the nightly summary. */
export async function approveClose(ctx: Ctx, dayId: string) {
  const [day] = await ctx.tx<DayRow[]>`select * from finance.business_days where id = ${dayId} for update`;
  if (!day || day.status !== 'submitted') throw conflict('not_submitted', 'This day is not waiting for approval.');
  const lines = await ctx.tx<{ money_account_id: string; expected_minor: number; declared_minor: number; ledger_account_id: string; name: string }[]>`
    select c.money_account_id, c.expected_minor, c.declared_minor, m.ledger_account_id, m.name
    from finance.day_close_lines c join finance.money_accounts m on m.id = c.money_account_id where c.business_day_id = ${dayId}`;
  const overShort = await accountId(ctx.tx, day.org_id, 'cash_over_short');
  for (const l of lines) {
    const diff = l.declared_minor - l.expected_minor;
    if (diff === 0) continue;
    await postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId: day.org_id, locationId: day.location_id, businessDayId: dayId,
      entryDate: day.business_date, memo: `${diff < 0 ? 'Short' : 'Over'} at close: ${l.name}`, sourceType: 'close_variance', sourceId: dayId,
      createdBy: ctx.actor.userId,
      lines: diff < 0
        ? [{ account: overShort, debit: -diff }, { account: l.ledger_account_id, credit: -diff, moneyAccountId: l.money_account_id }]
        : [{ account: l.ledger_account_id, debit: diff, moneyAccountId: l.money_account_id }, { account: overShort, credit: diff }] });
  }
  await accrueCommission(ctx, day);
  await ctx.tx`update finance.business_days set status = 'approved', approved_by = ${ctx.actor.userId}, approved_at = now() where id = ${dayId}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId: day.org_id, actorUserId: ctx.actor.userId, action: 'day.approved', entityType: 'business_day', entityId: dayId });
  const f = await dayFigures(ctx.tx, dayId);
  const [loc] = await ctx.tx<{ name: string }[]>`select name from core.locations where id = ${day.location_id}`;
  await notify(ctx.tx, { tenantId: ctx.tenantId, orgId: day.org_id, userIds: await partnerUserIds(ctx.tx, day.org_id), type: 'daily_summary',
    title: `${loc!.name} ${day.business_date}: sales ${fmt(f.sales)}, profit ${fmt(f.profit)}`,
    body: `Cost of sales ${fmt(f.cogs)} · other costs ${fmt(f.other_expenses + f.waste)} · refunds ${fmt(f.refunds)}`,
    link: `/days/${dayId}`, dedupeKey: `summary:${dayId}` });
}

export async function rejectClose(ctx: Ctx, dayId: string) {
  const [day] = await ctx.tx<DayRow[]>`select * from finance.business_days where id = ${dayId} for update`;
  if (!day || day.status !== 'submitted') return;
  if (await openDayFor(ctx.tx, day.location_id)) {
    throw conflict('another_day_open', 'Close the currently open day before sending this one back for correction.');
  }
  await ctx.tx`delete from finance.day_close_lines where business_day_id = ${dayId}`;
  await ctx.tx`update finance.business_days set status = 'open', submitted_at = null, submitted_by = null where id = ${dayId}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId: day.org_id, actorUserId: ctx.actor.userId, action: 'day.close_rejected', entityType: 'business_day', entityId: dayId });
}

/**
 * Commission is a per-person setting: a set percentage of the sales that person rang up that day,
 * net of voids. Partners have it off by default.
 */
async function accrueCommission(ctx: Ctx, day: DayRow) {
  const staff = await ctx.tx<{ id: string; person_id: string; commission_bps: number; user_id: string | null }[]>`
    select e.id, e.person_id, e.commission_bps, (select u.id from core.users u where u.person_id = e.person_id limit 1) as user_id
    from finance.employees e where e.org_id = ${day.org_id} and e.active and e.commission_enabled and e.commission_bps > 0
      and (e.location_id is null or e.location_id = ${day.location_id})`;
  if (staff.length === 0) return;
  const salesAcct = await accountId(ctx.tx, day.org_id, 'sales');
  const commAcct = await accountId(ctx.tx, day.org_id, 'commission');
  const payable = await accountId(ctx.tx, day.org_id, 'wages_payable');
  for (const s of staff) {
    if (!s.user_id) continue;
    const [r] = await ctx.tx<{ sales: number }[]>`
      select coalesce(sum(l.credit_minor - l.debit_minor), 0)::bigint as sales
      from finance.journal_entries e join finance.journal_lines l on l.entry_id = e.id
      where e.business_day_id = ${day.id} and e.source_type = 'order' and e.reverses_entry_id is null and e.created_by = ${s.user_id}
        and l.ledger_account_id = ${salesAcct}
        and not exists (select 1 from finance.journal_entries r where r.reverses_entry_id = e.id)`;
    const sales = r!.sales;
    const amount = applyBps(sales, s.commission_bps);
    let entryId: string | null = null;
    if (amount > 0) {
      entryId = await postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId: day.org_id, locationId: day.location_id, businessDayId: day.id,
        entryDate: day.business_date, memo: 'Sales commission', sourceType: 'commission', sourceId: s.id, createdBy: ctx.actor.userId,
        lines: [{ account: commAcct, debit: amount, personId: s.person_id }, { account: payable, credit: amount, personId: s.person_id }] });
    }
    await ctx.tx`insert into finance.commission_accruals (tenant_id, org_id, business_day_id, employee_id, sales_minor, commission_bps, amount_minor, journal_entry_id)
      values (${ctx.tenantId}, ${day.org_id}, ${day.id}, ${s.id}, ${sales}, ${s.commission_bps}, ${amount}, ${entryId})`;
  }
}

export async function listDays(ctx: Ctx, orgId: string, locationId: string | null, limit = 60) {
  requirePerm(ctx, 'reports.view', orgId, locationId);
  return ctx.tx`
    select d.id, d.location_id, l.name as location_name, d.business_date, d.status, d.opening_float_minor, d.opened_at, d.submitted_at, d.approved_at,
      coalesce(op.display_name, op.full_name, ou.username) as opened_by_name,
      (select coalesce(sum(jl.credit_minor - jl.debit_minor), 0)::bigint from finance.journal_lines jl join finance.journal_entries je on je.id = jl.entry_id
        join finance.ledger_accounts la on la.id = jl.ledger_account_id where je.business_day_id = d.id and la.system_key = 'sales') as sales_minor
    from finance.business_days d join core.locations l on l.id = d.location_id
    join core.users ou on ou.id = d.opened_by left join core.people op on op.id = ou.person_id
    where d.org_id = ${orgId} and (${locationId}::uuid is null or d.location_id = ${locationId})
    order by d.business_date desc, l.name limit ${limit}`;
}

export async function dayDetail(ctx: Ctx, orgId: string, dayId: string) {
  const day = await getDay(ctx.tx, orgId, dayId);
  requirePerm(ctx, 'reports.view', orgId, day.location_id);
  const lines = await ctx.tx`select c.money_account_id, m.name, m.kind, c.expected_minor, c.declared_minor
    from finance.day_close_lines c join finance.money_accounts m on m.id = c.money_account_id where c.business_day_id = ${dayId} order by m.kind, m.name`;
  return { day, figures: await dayFigures(ctx.tx, dayId), closeLines: lines };
}
