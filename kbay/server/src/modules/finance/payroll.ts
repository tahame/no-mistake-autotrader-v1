import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { mulDiv, toMilli } from '../../core/math.js';
import { accountId, postEntry } from '../ledger/index.js';
import { getOrg, localDate } from '../tenancy/index.js';
import { moneyAccount } from './accounts.js';
import { openDayFor } from './days.js';

// Labour is a real cost, tracked per employee: fixed monthly salary, daily or hourly pay, plus an
// optional sales commission that is a per-person setting (off by default, e.g. for partners).

export async function listEmployees(ctx: Ctx, orgId: string) {
  requirePerm(ctx, 'payroll.manage', orgId);
  const payable = await accountId(ctx.tx, orgId, 'wages_payable');
  return ctx.tx`
    select e.id, e.person_id, coalesce(p.display_name, p.full_name) as name, p.phone, e.location_id, l.name as location_name, e.title,
      e.pay_type, e.pay_rate_minor, e.commission_enabled, e.commission_bps, e.active, e.started_on, e.ended_on,
      (select coalesce(sum(jl.credit_minor - jl.debit_minor), 0)::bigint from finance.journal_lines jl
        where jl.ledger_account_id = ${payable} and jl.person_id = e.person_id) as commission_owed_minor
    from finance.employees e join core.people p on p.id = e.person_id left join core.locations l on l.id = e.location_id
    where e.org_id = ${orgId} order by e.active desc, name`;
}

export async function upsertEmployee(ctx: Ctx, orgId: string, input: { id?: string; personId: string; locationId?: string | null; title: string;
  payType: 'monthly' | 'daily' | 'hourly' | 'none'; payRateMinor: number; commissionEnabled: boolean; commissionBps: number; active?: boolean;
  startedOn?: string | null; endedOn?: string | null }) {
  requirePerm(ctx, 'payroll.manage', orgId);
  if (!Number.isSafeInteger(input.payRateMinor) || input.payRateMinor < 0) throw badRequest('bad_amount', 'Pay rate must be zero or more.');
  if (input.commissionBps < 0 || input.commissionBps > 10000) throw badRequest('bad_commission', 'Commission is between 0% and 100%.');
  if (input.id) {
    const [before] = await ctx.tx`select * from finance.employees where id = ${input.id} and org_id = ${orgId}`;
    if (!before) throw notFound('Employee');
    await ctx.tx`update finance.employees set location_id = ${input.locationId ?? null}, title = ${input.title}, pay_type = ${input.payType},
      pay_rate_minor = ${input.payRateMinor}, commission_enabled = ${input.commissionEnabled}, commission_bps = ${input.commissionBps},
      active = ${input.active ?? true}, started_on = ${input.startedOn ?? null}, ended_on = ${input.endedOn ?? null} where id = ${input.id}`;
    await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'employee.updated', entityType: 'employee', entityId: input.id, before, after: input });
    return { id: input.id };
  }
  const [r] = await ctx.tx<{ id: string }[]>`insert into finance.employees (tenant_id, org_id, person_id, location_id, title, pay_type, pay_rate_minor,
      commission_enabled, commission_bps, started_on)
    values (${ctx.tenantId}, ${orgId}, ${input.personId}, ${input.locationId ?? null}, ${input.title}, ${input.payType}, ${input.payRateMinor},
      ${input.commissionEnabled}, ${input.commissionBps}, ${input.startedOn ?? null}) returning id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'employee.created', entityType: 'employee', entityId: r!.id, after: input });
  return { id: r!.id };
}

/**
 * Pay wages: base = units (months / days / hours) x rate, plus any commission owed. Base is
 * booked as wages expense; commission was already expensed daily, so paying it clears what is owed.
 */
export async function payWages(ctx: Ctx, orgId: string, input: { employeeId: string; units: string; commissionMinor: number;
  moneyAccountId: string; periodFrom?: string | null; periodTo?: string | null; note?: string }) {
  requirePerm(ctx, 'payroll.manage', orgId);
  const [e] = await ctx.tx<{ person_id: string; location_id: string | null; pay_type: string; pay_rate_minor: number; name: string }[]>`
    select e.person_id, e.location_id, e.pay_type, e.pay_rate_minor, coalesce(p.display_name, p.full_name) as name
    from finance.employees e join core.people p on p.id = e.person_id where e.id = ${input.employeeId} and e.org_id = ${orgId}`;
  if (!e) throw notFound('Employee');
  const unitsMilli = toMilli(input.units || '0');
  if (unitsMilli < 0) throw badRequest('bad_units', 'Units cannot be negative.');
  const base = e.pay_type === 'none' ? 0 : mulDiv(e.pay_rate_minor, unitsMilli, 1000);
  if (!Number.isSafeInteger(input.commissionMinor) || input.commissionMinor < 0) throw badRequest('bad_amount', 'Commission must be zero or more.');
  const payable = await accountId(ctx.tx, orgId, 'wages_payable');
  const [owed] = await ctx.tx<{ v: number }[]>`select coalesce(sum(credit_minor - debit_minor), 0)::bigint as v from finance.journal_lines
    where ledger_account_id = ${payable} and person_id = ${e.person_id}`;
  if (input.commissionMinor > owed!.v) throw conflict('commission_exceeds', `Only Rs ${owed!.v / 100} commission is owed.`);
  const total = base + input.commissionMinor;
  if (total <= 0) throw badRequest('nothing_to_pay', 'Nothing to pay.');
  const acct = await moneyAccount(ctx.tx, orgId, input.moneyAccountId);
  const org = await getOrg(ctx.tx, orgId);
  const day = e.location_id ? await openDayFor(ctx.tx, e.location_id) : null;
  const [w] = await ctx.tx<{ id: string }[]>`insert into finance.wage_payments (tenant_id, org_id, location_id, business_day_id, employee_id, period_from,
      period_to, units, base_minor, commission_minor, total_minor, money_account_id, note, created_by)
    values (${ctx.tenantId}, ${orgId}, ${e.location_id}, ${day?.id ?? null}, ${input.employeeId}, ${input.periodFrom ?? null}, ${input.periodTo ?? null},
      ${input.units || '0'}, ${base}, ${input.commissionMinor}, ${total}, ${acct.id}, ${input.note ?? null}, ${ctx.actor.userId}) returning id`;
  const je = await postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: e.location_id, businessDayId: day?.id ?? null,
    entryDate: localDate(org.timezone), memo: `Wages: ${e.name}`, sourceType: 'wages', sourceId: w!.id, createdBy: ctx.actor.userId,
    lines: [
      { account: await accountId(ctx.tx, orgId, 'wages'), debit: base, personId: e.person_id },
      { account: payable, debit: input.commissionMinor, personId: e.person_id },
      { account: acct.ledger_account_id, credit: total, moneyAccountId: acct.id },
    ] });
  await ctx.tx`update finance.wage_payments set journal_entry_id = ${je} where id = ${w!.id}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'wages.paid', entityType: 'employee', entityId: input.employeeId,
    after: { ...input, baseMinor: base, totalMinor: total } });
  return { id: w!.id, baseMinor: base, totalMinor: total };
}

export async function listWagePayments(ctx: Ctx, orgId: string) {
  requirePerm(ctx, 'payroll.manage', orgId);
  return ctx.tx`select w.id, w.employee_id, coalesce(p.display_name, p.full_name) as name, w.period_from, w.period_to, w.units, w.base_minor,
      w.commission_minor, w.total_minor, m.name as account_name, w.created_at, w.note
    from finance.wage_payments w join finance.employees e on e.id = w.employee_id join core.people p on p.id = e.person_id
    join finance.money_accounts m on m.id = w.money_account_id where w.org_id = ${orgId} order by w.created_at desc limit 200`;
}
