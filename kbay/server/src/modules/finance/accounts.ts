import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, notFound } from '../../core/errors.js';
import type { Tx } from '../../db/db.js';
import { postEntry } from '../ledger/index.js';
import { getOrg, localDate } from '../tenancy/index.js';

export type MoneyKind = 'cash' | 'easypaisa' | 'jazzcash' | 'nayapay' | 'sadapay' | 'bank' | 'other';

/** Next free code in the 11xx range (each real money account gets its own ledger head). */
async function nextMoneyCode(tx: Tx, orgId: string): Promise<string> {
  const [r] = await tx<{ max: string | null }[]>`select max(code) as max from finance.ledger_accounts
    where org_id = ${orgId} and code between '1100' and '1199'`;
  const next = r?.max ? Number(r.max) + 1 : 1100;
  if (next > 1199) throw badRequest('too_many_accounts', 'Account limit reached for this organization.');
  return String(next);
}

export async function createMoneyAccountRaw(tx: Tx, tenantId: string, orgId: string, input: { name: string; kind: MoneyKind;
  locationId?: string | null; ownerPersonId?: string | null }) {
  const code = await nextMoneyCode(tx, orgId);
  const [la] = await tx<{ id: string }[]>`insert into finance.ledger_accounts (tenant_id, org_id, code, name, type)
    values (${tenantId}, ${orgId}, ${code}, ${input.name}, 'asset') returning id`;
  const [ma] = await tx<{ id: string }[]>`insert into finance.money_accounts (tenant_id, org_id, location_id, name, kind, owner_person_id, ledger_account_id)
    values (${tenantId}, ${orgId}, ${input.locationId ?? null}, ${input.name}, ${input.kind}, ${input.ownerPersonId ?? null}, ${la!.id}) returning id`;
  return ma!.id;
}

export async function createMoneyAccount(ctx: Ctx, orgId: string, input: { name: string; kind: MoneyKind; locationId?: string | null; ownerPersonId?: string | null }) {
  requirePerm(ctx, 'accounts.manage', orgId);
  const id = await createMoneyAccountRaw(ctx.tx, ctx.tenantId, orgId, input);
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'money_account.created', entityType: 'money_account', entityId: id, after: input });
  return { id };
}

export async function updateMoneyAccount(ctx: Ctx, orgId: string, id: string, input: { name?: string; ownerPersonId?: string | null; locationId?: string | null; active?: boolean }) {
  requirePerm(ctx, 'accounts.manage', orgId);
  const [before] = await ctx.tx`select * from finance.money_accounts where id = ${id} and org_id = ${orgId}`;
  if (!before) throw notFound('Account');
  await ctx.tx`update finance.money_accounts set name = coalesce(${input.name ?? null}, name),
    owner_person_id = ${input.ownerPersonId === undefined ? before.owner_person_id : input.ownerPersonId},
    location_id = ${input.locationId === undefined ? before.location_id : input.locationId},
    active = coalesce(${input.active ?? null}, active) where id = ${id}`;
  if (input.name) await ctx.tx`update finance.ledger_accounts set name = ${input.name} where id = ${before.ledger_account_id}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'money_account.updated', entityType: 'money_account', entityId: id, before, after: input });
}

export async function moneyAccount(tx: Tx, orgId: string, id: string) {
  const [a] = await tx<{ id: string; name: string; kind: MoneyKind; ledger_account_id: string; location_id: string | null; active: boolean;
    owner_person_id: string | null }[]>`
    select id, name, kind, ledger_account_id, location_id, active, owner_person_id from finance.money_accounts where id = ${id} and org_id = ${orgId}`;
  if (!a) throw notFound('Account');
  if (!a.active) throw badRequest('account_inactive', `${a.name} is switched off.`);
  return a;
}

/** All accounts with their business balance (what the books say belongs to the business there). */
export async function listMoneyAccounts(ctx: Ctx, orgId: string, opts: { withBalances: boolean }) {
  const rows = await ctx.tx`
    select m.id, m.name, m.kind, m.location_id, l.name as location_name, m.owner_person_id,
           coalesce(p.display_name, p.full_name) as owner_name, m.active, m.ledger_account_id,
           case when ${opts.withBalances} then
             (select coalesce(sum(jl.debit_minor - jl.credit_minor), 0)::bigint from finance.journal_lines jl where jl.ledger_account_id = m.ledger_account_id)
           end as balance_minor
    from finance.money_accounts m left join core.locations l on l.id = m.location_id left join core.people p on p.id = m.owner_person_id
    where m.org_id = ${orgId} order by m.active desc, m.kind, m.name`;
  return rows;
}

export async function ledgerHeads(ctx: Ctx, orgId: string) {
  return ctx.tx`select id, code, name, type, system_key, is_expense_category, active from finance.ledger_accounts
    where org_id = ${orgId} order by code`;
}

export async function addExpenseHead(ctx: Ctx, orgId: string, input: { name: string }) {
  requirePerm(ctx, 'accounts.manage', orgId);
  const [r] = await ctx.tx<{ max: string | null }[]>`select max(code) as max from finance.ledger_accounts where org_id = ${orgId} and code between '6100' and '6999'`;
  const code = String(Math.max(Number(r?.max ?? 6900), 6900) + 1);
  const [a] = await ctx.tx<{ id: string }[]>`insert into finance.ledger_accounts (tenant_id, org_id, code, name, type, is_expense_category)
    values (${ctx.tenantId}, ${orgId}, ${code}, ${input.name}, 'expense', true) returning id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'ledger_head.created', entityType: 'ledger_account', entityId: a!.id, after: input });
  return { id: a!.id };
}

/** Move money between two accounts (e.g. cash drawer -> Taha's bank at close). */
export async function transfer(ctx: Ctx, orgId: string, input: { fromAccountId: string; toAccountId: string; amountMinor: number; note?: string;
  locationId?: string | null; businessDayId?: string | null }, opts: { skipPermission?: boolean } = {}) {
  if (!opts.skipPermission && !ctx.access.can('day.close', orgId, input.locationId) && !ctx.access.can('accounts.manage', orgId)) {
    requirePerm(ctx, 'day.close', orgId, input.locationId);
  }
  if (input.fromAccountId === input.toAccountId) throw badRequest('same_account', 'Pick two different accounts.');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest('bad_amount', 'Amount must be above zero.');
  const from = await moneyAccount(ctx.tx, orgId, input.fromAccountId);
  const to = await moneyAccount(ctx.tx, orgId, input.toAccountId);
  const org = await getOrg(ctx.tx, orgId);
  const id = crypto.randomUUID();
  await postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: input.locationId ?? null, businessDayId: input.businessDayId ?? null,
    entryDate: localDate(org.timezone), memo: `Transfer ${from.name} → ${to.name}${input.note ? `: ${input.note}` : ''}`,
    sourceType: 'transfer', sourceId: id, createdBy: ctx.actor.userId,
    lines: [
      { account: to.ledger_account_id, debit: input.amountMinor, moneyAccountId: to.id },
      { account: from.ledger_account_id, credit: input.amountMinor, moneyAccountId: from.id },
    ] });
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'money.transfer', entityType: 'money_account', entityId: from.id, after: input });
  return { id };
}

export async function accountStatement(ctx: Ctx, orgId: string, moneyAccountId: string) {
  requirePerm(ctx, 'finance.view', orgId);
  const [a] = await ctx.tx<{ ledger_account_id: string }[]>`
    select ledger_account_id from finance.money_accounts where id = ${moneyAccountId} and org_id = ${orgId}`;
  if (!a) throw notFound('Account');
  return ctx.tx`
    select e.id as entry_id, e.entry_date, e.memo, e.source_type, e.created_at, l.debit_minor, l.credit_minor,
           sum(l.debit_minor - l.credit_minor) over (order by e.created_at, l.id)::bigint as running_minor
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    where l.ledger_account_id = ${a.ledger_account_id}
    order by e.created_at desc, l.id desc limit 300`;
}

// ---- Suppliers and what is owed to them (udhaar) ----

export async function listSuppliers(ctx: Ctx, orgId: string) {
  return ctx.tx`
    select s.id, s.name, s.phone, s.notes, s.active,
      (select coalesce(sum(jl.credit_minor - jl.debit_minor), 0)::bigint from finance.journal_lines jl
        join finance.ledger_accounts la on la.id = jl.ledger_account_id
        where la.org_id = ${orgId} and la.system_key = 'payables' and jl.supplier_id = s.id) as owed_minor
    from finance.suppliers s where s.org_id = ${orgId} order by s.active desc, s.name`;
}

export async function upsertSupplier(ctx: Ctx, orgId: string, input: { id?: string; name: string; phone?: string | null; notes?: string | null; active?: boolean }) {
  requirePerm(ctx, 'supplier.manage', orgId);
  if (input.id) {
    await ctx.tx`update finance.suppliers set name = ${input.name}, phone = ${input.phone ?? null}, notes = ${input.notes ?? null},
      active = ${input.active ?? true} where id = ${input.id} and org_id = ${orgId}`;
    await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'supplier.updated', entityType: 'supplier', entityId: input.id, after: input });
    return { id: input.id };
  }
  const [s] = await ctx.tx<{ id: string }[]>`insert into finance.suppliers (tenant_id, org_id, name, phone, notes)
    values (${ctx.tenantId}, ${orgId}, ${input.name}, ${input.phone ?? null}, ${input.notes ?? null}) returning id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'supplier.created', entityType: 'supplier', entityId: s!.id, after: input });
  return { id: s!.id };
}

// ---- Setup hooks ----

export async function setupLocationAccounts(tx: Tx, tenantId: string, orgId: string, locationId: string, name: string) {
  await createMoneyAccountRaw(tx, tenantId, orgId, { name: `${name} — cash drawer`, kind: 'cash', locationId });
}

export async function defaultCashAccount(tx: Tx, orgId: string, locationId: string): Promise<string | null> {
  const [a] = await tx<{ id: string }[]>`select id from finance.money_accounts
    where org_id = ${orgId} and location_id = ${locationId} and kind = 'cash' and active order by created_at limit 1`;
  return a?.id ?? null;
}
