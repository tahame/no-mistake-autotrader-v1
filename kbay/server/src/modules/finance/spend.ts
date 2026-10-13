import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { fromMilli as milliStr, toMilli } from '../../core/math.js';
import type { Dimension } from '../../core/units.js';
import { toBaseMilli } from '../../core/units.js';
import { requestApproval } from '../approvals/index.js';
import { receiveStock } from '../inventory/index.js';
import { accountId, postEntry } from '../ledger/index.js';
import { assertLocationInOrg, getOrg, localDate } from '../tenancy/index.js';
import { moneyAccount } from './accounts.js';
import { openDayFor } from './days.js';

// Spending: small everyday spends under the location's limit are simply logged; anything above it,
// and any purchase on supplier credit (udhaar), needs a partner's approval before it counts.

async function limitFor(ctx: Ctx, orgId: string, locationId: string | null): Promise<number> {
  if (locationId) return (await assertLocationInOrg(ctx.tx, orgId, locationId)).approval_limit_minor;
  const org = await getOrg(ctx.tx, orgId);
  return Number((org.settings as { approvalLimitMinor?: number }).approvalLimitMinor ?? 200000);
}

function approvalKind(payment: 'paid' | 'credit', amount: number, limit: number) {
  if (payment === 'credit') return 'supplier_credit' as const;
  return amount > limit ? ('expense' as const) : null;
}

const fmt = (minor: number) => `Rs ${(minor / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;

// ---- Expenses ----

export async function createExpense(ctx: Ctx, orgId: string, input: { locationId?: string | null; categoryAccountId: string; amountMinor: number;
  payment: 'paid' | 'credit'; moneyAccountId?: string | null; supplierId?: string | null; payee?: string | null; description: string }) {
  requirePerm(ctx, 'expense.create', orgId, input.locationId);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest('bad_amount', 'Amount must be above zero.');
  if (!input.description.trim()) throw badRequest('description_required', 'Say what it was for.');
  const [head] = await ctx.tx<{ is_expense_category: boolean; name: string }[]>`
    select is_expense_category, name from finance.ledger_accounts where id = ${input.categoryAccountId} and org_id = ${orgId}`;
  if (!head?.is_expense_category) throw badRequest('bad_category', 'Pick an expense category.');
  if (input.payment === 'paid') {
    if (!input.moneyAccountId) throw badRequest('account_required', 'Which account paid?');
    await moneyAccount(ctx.tx, orgId, input.moneyAccountId);
  } else if (!input.supplierId) {
    throw badRequest('supplier_required', 'On credit needs the supplier owed.');
  }
  const day = input.locationId ? await openDayFor(ctx.tx, input.locationId) : null;
  const limit = await limitFor(ctx, orgId, input.locationId ?? null);
  const kind = approvalKind(input.payment, input.amountMinor, limit);
  const [e] = await ctx.tx<{ id: string }[]>`insert into finance.expenses (tenant_id, org_id, location_id, business_day_id, category_account_id,
      amount_minor, payment, money_account_id, supplier_id, payee, description, status, created_by)
    values (${ctx.tenantId}, ${orgId}, ${input.locationId ?? null}, ${day?.id ?? null}, ${input.categoryAccountId}, ${input.amountMinor},
      ${input.payment}, ${input.moneyAccountId ?? null}, ${input.supplierId ?? null}, ${input.payee ?? null}, ${input.description.trim()},
      ${kind ? 'pending_approval' : 'posted'}, ${ctx.actor.userId}) returning id`;
  const id = e!.id;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'expense.created', entityType: 'expense', entityId: id, after: input });
  if (kind) {
    const approvalId = await requestApproval(ctx, { orgId, locationId: input.locationId, kind, subjectType: 'expense', subjectId: id,
      summary: `${head.name}: ${input.description.trim()} — ${fmt(input.amountMinor)}${input.payment === 'credit' ? ' on credit' : ''}`,
      amountMinor: input.amountMinor });
    await ctx.tx`update finance.expenses set approval_id = ${approvalId} where id = ${id}`;
    return { id, status: 'pending_approval' as const, approvalId };
  }
  await postExpense(ctx, id);
  return { id, status: 'posted' as const };
}

export async function postExpense(ctx: Ctx, expenseId: string) {
  const [x] = await ctx.tx<{ org_id: string; location_id: string | null; business_day_id: string | null; category_account_id: string; amount_minor: number;
    payment: 'paid' | 'credit'; money_account_id: string | null; supplier_id: string | null; description: string; status: string; created_by: string }[]>`
    select org_id, location_id, business_day_id, category_account_id, amount_minor, payment, money_account_id, supplier_id, description, status, created_by
    from finance.expenses where id = ${expenseId} for update`;
  if (!x) throw notFound('Expense');
  const org = await getOrg(ctx.tx, x.org_id);
  const dayId = await stillOpen(ctx, x.business_day_id);
  const credit = x.payment === 'paid'
    ? { account: (await moneyAccount(ctx.tx, x.org_id, x.money_account_id!)).ledger_account_id, credit: x.amount_minor, moneyAccountId: x.money_account_id }
    : { account: await accountId(ctx.tx, x.org_id, 'payables'), credit: x.amount_minor, supplierId: x.supplier_id };
  const entryId = await postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId: x.org_id, locationId: x.location_id, businessDayId: dayId,
    entryDate: localDate(org.timezone), memo: x.description, sourceType: 'expense', sourceId: expenseId, createdBy: x.created_by,
    lines: [{ account: x.category_account_id, debit: x.amount_minor, supplierId: x.supplier_id }, credit] });
  await ctx.tx`update finance.expenses set status = 'posted', journal_entry_id = ${entryId} where id = ${expenseId}`;
}

/** Attach a late posting to its day only while that day is still open. */
async function stillOpen(ctx: Ctx, dayId: string | null): Promise<string | null> {
  if (!dayId) return null;
  const [d] = await ctx.tx<{ status: string }[]>`select status from finance.business_days where id = ${dayId}`;
  return d?.status === 'open' ? dayId : null;
}

export async function rejectExpense(ctx: Ctx, expenseId: string) {
  await ctx.tx`update finance.expenses set status = 'rejected' where id = ${expenseId} and status = 'pending_approval'`;
}

export async function listExpenses(ctx: Ctx, orgId: string, opts: { locationId?: string | null; from?: string; to?: string }) {
  requirePerm(ctx, 'finance.view', orgId, opts.locationId);
  return ctx.tx`
    select x.id, x.location_id, l.name as location_name, x.amount_minor, x.payment, x.description, x.payee, x.status, x.created_at,
      la.name as category, ma.name as account_name, s.name as supplier_name, x.approval_id,
      coalesce(p.display_name, p.full_name, u.username) as created_by_name
    from finance.expenses x join finance.ledger_accounts la on la.id = x.category_account_id
    left join core.locations l on l.id = x.location_id left join finance.money_accounts ma on ma.id = x.money_account_id
    left join finance.suppliers s on s.id = x.supplier_id
    join core.users u on u.id = x.created_by left join core.people p on p.id = u.person_id
    where x.org_id = ${orgId} and (${opts.locationId ?? null}::uuid is null or x.location_id = ${opts.locationId ?? null})
      and (${opts.from ?? null}::date is null or x.created_at >= ${opts.from ?? null}::date)
      and (${opts.to ?? null}::date is null or x.created_at < (${opts.to ?? null}::date + 1))
    order by x.created_at desc limit 300`;
}

// ---- Purchases (stock in) ----

export async function createPurchase(ctx: Ctx, orgId: string, input: { locationId: string; supplierId: string; payment: 'paid' | 'credit';
  moneyAccountId?: string | null; note?: string | null; lines: { itemId: string; qty: string; unit: string; totalMinor: number }[] }) {
  requirePerm(ctx, 'purchase.create', orgId, input.locationId);
  await assertLocationInOrg(ctx.tx, orgId, input.locationId);
  if (input.lines.length === 0) throw badRequest('no_lines', 'Add at least one item.');
  const [sup] = await ctx.tx<{ name: string }[]>`select name from finance.suppliers where id = ${input.supplierId} and org_id = ${orgId}`;
  if (!sup) throw notFound('Supplier');
  if (input.payment === 'paid') {
    if (!input.moneyAccountId) throw badRequest('account_required', 'Which account paid?');
    await moneyAccount(ctx.tx, orgId, input.moneyAccountId);
  }
  const prepared = [];
  for (const l of input.lines) {
    const [it] = await ctx.tx<{ name: string; kind: string; dimension: Dimension }[]>`
      select name, kind, dimension from inventory.items where id = ${l.itemId} and org_id = ${orgId}`;
    if (!it) throw notFound('Stock item');
    if (it.kind !== 'stock') throw badRequest('not_stock_item', `${it.name} is a group or mix — pick the exact item or variety bought.`);
    if (!Number.isSafeInteger(l.totalMinor) || l.totalMinor <= 0) throw badRequest('bad_amount', `Enter what ${it.name} cost.`);
    const qtyBase = toBaseMilli(l.qty, l.unit, it.dimension);
    if (qtyBase <= 0) throw badRequest('bad_qty', `Enter how much ${it.name} was bought.`);
    prepared.push({ ...l, qtyBase, name: it.name });
  }
  const total = prepared.reduce((a, l) => a + l.totalMinor, 0);
  const day = await openDayFor(ctx.tx, input.locationId);
  const limit = await limitFor(ctx, orgId, input.locationId);
  const kind = input.payment === 'credit' ? 'supplier_credit' as const : total > limit ? 'purchase' as const : null;
  const [p] = await ctx.tx<{ id: string }[]>`insert into finance.purchases (tenant_id, org_id, location_id, business_day_id, supplier_id, payment,
      money_account_id, total_minor, note, status, created_by)
    values (${ctx.tenantId}, ${orgId}, ${input.locationId}, ${day?.id ?? null}, ${input.supplierId}, ${input.payment}, ${input.moneyAccountId ?? null},
      ${total}, ${input.note ?? null}, ${kind ? 'pending_approval' : 'posted'}, ${ctx.actor.userId}) returning id`;
  const id = p!.id;
  for (const l of prepared) {
    await ctx.tx`insert into finance.purchase_lines (tenant_id, purchase_id, item_id, qty, unit, qty_base, total_minor)
      values (${ctx.tenantId}, ${id}, ${l.itemId}, ${l.qty}, ${l.unit}, ${milliStr(l.qtyBase)}, ${l.totalMinor})`;
  }
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'purchase.created', entityType: 'purchase', entityId: id, after: input });
  if (kind) {
    const approvalId = await requestApproval(ctx, { orgId, locationId: input.locationId, kind, subjectType: 'purchase', subjectId: id,
      summary: `Buy from ${sup.name}: ${prepared.map((l) => `${l.name} ${l.qty} ${l.unit}`).join(', ')} — ${fmt(total)}${input.payment === 'credit' ? ' on credit' : ''}`,
      amountMinor: total });
    await ctx.tx`update finance.purchases set approval_id = ${approvalId} where id = ${id}`;
    return { id, status: 'pending_approval' as const, approvalId, totalMinor: total };
  }
  await postPurchase(ctx, id);
  return { id, status: 'posted' as const, totalMinor: total };
}

/** A posted purchase adds stock at its price and records the payment or the amount owed. */
export async function postPurchase(ctx: Ctx, purchaseId: string) {
  const [p] = await ctx.tx<{ org_id: string; location_id: string; business_day_id: string | null; supplier_id: string; payment: 'paid' | 'credit';
    money_account_id: string | null; total_minor: number; status: string; created_by: string; supplier_name: string }[]>`
    select p.org_id, p.location_id, p.business_day_id, p.supplier_id, p.payment, p.money_account_id, p.total_minor, p.status, p.created_by,
      s.name as supplier_name
    from finance.purchases p join finance.suppliers s on s.id = p.supplier_id where p.id = ${purchaseId} for update of p`;
  if (!p) throw notFound('Purchase');
  const org = await getOrg(ctx.tx, p.org_id);
  const dayId = await stillOpen(ctx, p.business_day_id);
  const lines = await ctx.tx<{ id: string; item_id: string; qty_base: string; total_minor: number }[]>`
    select id, item_id, qty_base, total_minor from finance.purchase_lines where purchase_id = ${purchaseId}`;
  for (const l of lines) {
    await receiveStock(ctx.tx, { tenantId: ctx.tenantId, orgId: p.org_id, locationId: p.location_id, itemId: l.item_id,
      qtyMilli: toMilli(l.qty_base), valueMinor: l.total_minor,
      businessDayId: dayId, purchaseId, lineId: l.id, createdBy: p.created_by });
  }
  const credit = p.payment === 'paid'
    ? { account: (await moneyAccount(ctx.tx, p.org_id, p.money_account_id!)).ledger_account_id, credit: p.total_minor, moneyAccountId: p.money_account_id }
    : { account: await accountId(ctx.tx, p.org_id, 'payables'), credit: p.total_minor, supplierId: p.supplier_id };
  const entryId = await postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId: p.org_id, locationId: p.location_id, businessDayId: dayId,
    entryDate: localDate(org.timezone), memo: `Stock from ${p.supplier_name}`, sourceType: 'purchase', sourceId: purchaseId, createdBy: p.created_by,
    lines: [{ account: await accountId(ctx.tx, p.org_id, 'inventory'), debit: p.total_minor, supplierId: p.supplier_id }, credit] });
  await ctx.tx`update finance.purchases set status = 'posted', journal_entry_id = ${entryId} where id = ${purchaseId}`;
}

export async function rejectPurchase(ctx: Ctx, purchaseId: string) {
  await ctx.tx`update finance.purchases set status = 'rejected' where id = ${purchaseId} and status = 'pending_approval'`;
}

export async function listPurchases(ctx: Ctx, orgId: string, opts: { locationId?: string | null }) {
  requirePerm(ctx, 'finance.view', orgId, opts.locationId);
  return ctx.tx`
    select p.id, p.location_id, l.name as location_name, s.name as supplier_name, p.payment, p.total_minor, p.status, p.note, p.created_at,
      ma.name as account_name, coalesce(pp.display_name, pp.full_name, u.username) as created_by_name,
      (select json_agg(json_build_object('itemId', pl.item_id, 'name', i.name, 'qty', pl.qty, 'unit', pl.unit, 'totalMinor', pl.total_minor))
        from finance.purchase_lines pl join inventory.items i on i.id = pl.item_id where pl.purchase_id = p.id) as lines
    from finance.purchases p join core.locations l on l.id = p.location_id join finance.suppliers s on s.id = p.supplier_id
    left join finance.money_accounts ma on ma.id = p.money_account_id
    join core.users u on u.id = p.created_by left join core.people pp on pp.id = u.person_id
    where p.org_id = ${orgId} and (${opts.locationId ?? null}::uuid is null or p.location_id = ${opts.locationId ?? null})
    order by p.created_at desc limit 300`;
}

/** Price awareness: what each supplier charged per purchase unit for an item over time. */
export async function priceHistory(ctx: Ctx, orgId: string, itemId: string) {
  requirePerm(ctx, 'finance.view', orgId);
  return ctx.tx`
    select p.created_at, s.id as supplier_id, s.name as supplier_name, pl.qty, pl.unit, pl.total_minor,
      round(pl.total_minor / pl.qty)::bigint as unit_price_minor
    from finance.purchase_lines pl join finance.purchases p on p.id = pl.purchase_id join finance.suppliers s on s.id = p.supplier_id
    where pl.item_id = ${itemId} and p.org_id = ${orgId} and p.status = 'posted' order by p.created_at desc limit 100`;
}

// ---- Settling supplier credit ----

export async function paySupplier(ctx: Ctx, orgId: string, input: { supplierId: string; amountMinor: number; moneyAccountId: string;
  locationId?: string | null; note?: string }) {
  requirePerm(ctx, 'supplier.pay', orgId, input.locationId);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest('bad_amount', 'Amount must be above zero.');
  const payables = await accountId(ctx.tx, orgId, 'payables');
  const [owed] = await ctx.tx<{ v: number }[]>`select coalesce(sum(credit_minor - debit_minor), 0)::bigint as v from finance.journal_lines
    where ledger_account_id = ${payables} and supplier_id = ${input.supplierId}`;
  if (input.amountMinor > owed!.v) throw conflict('overpayment', `Only ${fmt(owed!.v)} is owed to this supplier.`);
  const acct = await moneyAccount(ctx.tx, orgId, input.moneyAccountId);
  const org = await getOrg(ctx.tx, orgId);
  const day = input.locationId ? await openDayFor(ctx.tx, input.locationId) : null;
  const [sp] = await ctx.tx<{ id: string }[]>`insert into finance.supplier_payments (tenant_id, org_id, location_id, supplier_id, amount_minor,
      money_account_id, note, created_by)
    values (${ctx.tenantId}, ${orgId}, ${input.locationId ?? null}, ${input.supplierId}, ${input.amountMinor}, ${input.moneyAccountId},
      ${input.note ?? null}, ${ctx.actor.userId}) returning id`;
  const entryId = await postEntry(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: input.locationId ?? null, businessDayId: day?.id ?? null,
    entryDate: localDate(org.timezone), memo: `Paid supplier${input.note ? `: ${input.note}` : ''}`, sourceType: 'supplier_payment', sourceId: sp!.id,
    createdBy: ctx.actor.userId,
    lines: [{ account: payables, debit: input.amountMinor, supplierId: input.supplierId },
      { account: acct.ledger_account_id, credit: input.amountMinor, moneyAccountId: acct.id }] });
  await ctx.tx`update finance.supplier_payments set journal_entry_id = ${entryId} where id = ${sp!.id}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'supplier.paid', entityType: 'supplier', entityId: input.supplierId, after: input });
  return { id: sp!.id };
}
