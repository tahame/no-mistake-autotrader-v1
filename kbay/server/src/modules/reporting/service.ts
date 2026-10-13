import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import type { OrderCompleted, OrderVoided } from '../../contracts/order-events.js';
import type { Tx } from '../../db/db.js';

// Reporting is the read side. Sales facts arrive from the order events; money figures come
// straight from the ledger, so every report adds up to the same numbers the books hold.

export async function onOrderCompleted(tx: Tx, e: OrderCompleted) {
  for (const l of e.lines) {
    await tx`insert into reporting.sales_lines (order_line_id, tenant_id, org_id, location_id, business_day_id, business_date, order_id, sold_at,
        sold_by, menu_item_id, variant_id, item_name, variant_name, category_name, qty, revenue_minor)
      values (${l.lineId}, ${e.tenantId}, ${e.orgId}, ${e.locationId}, ${e.businessDayId}, ${e.businessDate}, ${e.orderId}, ${e.createdAt},
        ${e.createdBy}, ${l.menuItemId}, ${l.variantId}, ${l.itemName}, ${l.variantName}, ${l.categoryName}, ${l.qty}, ${l.lineTotalMinor})
      on conflict (order_line_id) do nothing`;
  }
}

export async function onOrderVoided(tx: Tx, e: OrderVoided) {
  await tx`update reporting.sales_lines set voided = true where order_id = ${e.orderId}`;
}

export interface Range { from: string; to: string; locationId?: string | null }

/** Headline numbers + daily series for the dashboard, all from the ledger. */
export async function dashboard(ctx: Ctx, orgId: string, r: Range) {
  requirePerm(ctx, 'reports.view', orgId, r.locationId);
  const loc = r.locationId ?? null;
  const [totals] = await ctx.tx<{ sales: number; refunds: number; revenue: number; cogs: number; expenses: number }[]>`
    select
      coalesce(sum(case when la.system_key = 'sales' then l.credit_minor - l.debit_minor end), 0)::bigint as sales,
      coalesce(sum(case when la.system_key = 'sales_returns' then l.debit_minor - l.credit_minor end), 0)::bigint as refunds,
      coalesce(sum(case when la.type = 'revenue' then l.credit_minor - l.debit_minor end), 0)::bigint as revenue,
      coalesce(sum(case when la.system_key in ('cogs_food', 'cogs_beverage', 'cogs_packaging', 'cogs_fuel') then l.debit_minor - l.credit_minor end), 0)::bigint as cogs,
      coalesce(sum(case when la.type = 'expense' then l.debit_minor - l.credit_minor end), 0)::bigint as expenses
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.ledger_accounts la on la.id = l.ledger_account_id
    where e.org_id = ${orgId} and e.entry_date between ${r.from} and ${r.to}
      and (${loc}::uuid is null or coalesce(l.location_id, e.location_id) = ${loc})`;
  const series = await ctx.tx<{ d: string; sales: number; profit: number }[]>`
    select e.entry_date as d,
      coalesce(sum(case when la.system_key = 'sales' then l.credit_minor - l.debit_minor end), 0)::bigint as sales,
      coalesce(sum(case when la.type in ('revenue', 'expense') then l.credit_minor - l.debit_minor end), 0)::bigint as profit
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.ledger_accounts la on la.id = l.ledger_account_id
    where e.org_id = ${orgId} and e.entry_date between ${r.from} and ${r.to}
      and (${loc}::uuid is null or coalesce(l.location_id, e.location_id) = ${loc})
    group by e.entry_date order by e.entry_date`;
  const [counts] = await ctx.tx<{ orders: number; plates: number }[]>`
    select count(distinct order_id)::int as orders, coalesce(sum(qty), 0)::int as plates from reporting.sales_lines
    where org_id = ${orgId} and not voided and business_date between ${r.from} and ${r.to} and (${loc}::uuid is null or location_id = ${loc})`;
  const t = totals!;
  return { ...t, profit: t.revenue - t.expenses, grossProfit: t.revenue - t.cogs, orders: counts!.orders, plates: counts!.plates, series };
}

/** Where the money goes: every expense head (cost of food, gas, wages, rent...) for the period. */
export async function expensesByCategory(ctx: Ctx, orgId: string, r: Range) {
  requirePerm(ctx, 'reports.view', orgId, r.locationId);
  const loc = r.locationId ?? null;
  const heads = await ctx.tx`
    select la.code, la.name, sum(l.debit_minor - l.credit_minor)::bigint as amount_minor
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.ledger_accounts la on la.id = l.ledger_account_id
    where e.org_id = ${orgId} and la.type = 'expense' and e.entry_date between ${r.from} and ${r.to}
      and (${loc}::uuid is null or coalesce(l.location_id, e.location_id) = ${loc})
    group by la.code, la.name having sum(l.debit_minor - l.credit_minor) <> 0 order by amount_minor desc`;
  // Cash view: what was bought, by stock category (potatoes, oil, gas, packaging...).
  const purchases = await ctx.tx`
    select i.category, sum(pl.total_minor)::bigint as amount_minor
    from finance.purchase_lines pl join finance.purchases p on p.id = pl.purchase_id join inventory.items i on i.id = pl.item_id
    where p.org_id = ${orgId} and p.status = 'posted' and p.created_at::date between ${r.from} and ${r.to}
      and (${loc}::uuid is null or p.location_id = ${loc})
    group by i.category order by amount_minor desc`;
  return { heads, purchases };
}

/** Which stall performs best. */
export async function stallComparison(ctx: Ctx, orgId: string, r: Range) {
  requirePerm(ctx, 'reports.view', orgId);
  return ctx.tx`
    select lo.id as location_id, lo.name, lo.kind,
      coalesce(sum(case when la.system_key = 'sales' then l.credit_minor - l.debit_minor end), 0)::bigint as sales_minor,
      coalesce(sum(case when la.type in ('revenue', 'expense') then l.credit_minor - l.debit_minor end), 0)::bigint as profit_minor,
      count(distinct e.business_day_id)::int as days
    from core.locations lo
    left join finance.journal_entries e on e.location_id = lo.id and e.entry_date between ${r.from} and ${r.to}
    left join finance.journal_lines l on l.entry_id = e.id
    left join finance.ledger_accounts la on la.id = l.ledger_account_id
    where lo.org_id = ${orgId}
    group by lo.id, lo.name, lo.kind order by sales_minor desc`;
}

/**
 * Per size: how many sold, revenue, and the actual ingredient cost drawn from stock for those
 * sales — so you learn which portion size really makes the most money.
 */
export async function plateProfit(ctx: Ctx, orgId: string, r: Range) {
  requirePerm(ctx, 'reports.view', orgId, r.locationId);
  const loc = r.locationId ?? null;
  return ctx.tx`
    select s.item_name, s.variant_name, s.variant_id, s.category_name,
      sum(s.qty)::int as qty, sum(s.revenue_minor)::bigint as revenue_minor,
      coalesce(sum(c.cost), 0)::bigint as cost_minor,
      (sum(s.revenue_minor) - coalesce(sum(c.cost), 0))::bigint as profit_minor,
      case when sum(s.qty) > 0 then round((sum(s.revenue_minor) - coalesce(sum(c.cost), 0))::numeric / sum(s.qty))::bigint end as profit_per_plate_minor
    from reporting.sales_lines s
    left join lateral (select -sum(m.value_minor) as cost from inventory.movements m where m.ref_line_id = s.order_line_id and m.reason = 'sale') c on true
    where s.org_id = ${orgId} and not s.voided and s.business_date between ${r.from} and ${r.to} and (${loc}::uuid is null or s.location_id = ${loc})
    group by s.item_name, s.variant_name, s.variant_id, s.category_name
    order by profit_minor desc`;
}

/** Busiest hours (local time), so staffing and prep match real demand. */
export async function salesByHour(ctx: Ctx, orgId: string, r: Range & { timezone: string }) {
  requirePerm(ctx, 'reports.view', orgId, r.locationId);
  const loc = r.locationId ?? null;
  return ctx.tx`
    select extract(hour from s.sold_at at time zone ${r.timezone})::int as hour, sum(s.revenue_minor)::bigint as revenue_minor, sum(s.qty)::int as qty
    from reporting.sales_lines s
    where s.org_id = ${orgId} and not s.voided and s.business_date between ${r.from} and ${r.to} and (${loc}::uuid is null or s.location_id = ${loc})
    group by 1 order by 1`;
}

/** Labour cost per person: wages paid and commission earned in the period. */
export async function labour(ctx: Ctx, orgId: string, r: Range) {
  requirePerm(ctx, 'reports.view', orgId, r.locationId);
  return ctx.tx`
    select p.id as person_id, coalesce(p.display_name, p.full_name) as name,
      coalesce(sum(case when la.system_key = 'wages' then l.debit_minor - l.credit_minor end), 0)::bigint as wages_minor,
      coalesce(sum(case when la.system_key = 'commission' then l.debit_minor - l.credit_minor end), 0)::bigint as commission_minor
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.ledger_accounts la on la.id = l.ledger_account_id join core.people p on p.id = l.person_id
    where e.org_id = ${orgId} and la.system_key in ('wages', 'commission') and e.entry_date between ${r.from} and ${r.to}
    group by p.id, name order by name`;
}

/** Voids and refunds by person: the first place to look for hidden theft. */
export async function voidsAndRefunds(ctx: Ctx, orgId: string, r: Range) {
  requirePerm(ctx, 'reports.view', orgId, r.locationId);
  const loc = r.locationId ?? null;
  return ctx.tx`
    select e.source_type as kind, e.entry_date, e.memo, coalesce(p.display_name, p.full_name, u.username) as by_name,
      sum(l.debit_minor)::bigint as amount_minor, lo.name as location_name
    from finance.journal_entries e join finance.journal_lines l on l.entry_id = e.id
    left join core.users u on u.id = e.created_by left join core.people p on p.id = u.person_id
    left join core.locations lo on lo.id = e.location_id
    where e.org_id = ${orgId} and e.source_type in ('order_void', 'refund') and e.entry_date between ${r.from} and ${r.to}
      and (${loc}::uuid is null or e.location_id = ${loc})
    group by e.id, e.source_type, e.entry_date, e.memo, by_name, lo.name order by e.entry_date desc`;
}

/** Profit and loss by account head for a period (proper accounting view). */
export async function profitAndLoss(ctx: Ctx, orgId: string, r: Range) {
  requirePerm(ctx, 'finance.view', orgId, r.locationId);
  const loc = r.locationId ?? null;
  return ctx.tx`
    select la.code, la.name, la.type, sum(l.credit_minor - l.debit_minor)::bigint as amount_minor
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    join finance.ledger_accounts la on la.id = l.ledger_account_id
    where e.org_id = ${orgId} and la.type in ('revenue', 'expense') and e.entry_date between ${r.from} and ${r.to}
      and (${loc}::uuid is null or coalesce(l.location_id, e.location_id) = ${loc})
    group by la.code, la.name, la.type order by la.code`;
}

/** Balance sheet style snapshot: every account head's balance at a date. Debits must equal credits. */
export async function trialBalance(ctx: Ctx, orgId: string, asOf: string) {
  requirePerm(ctx, 'finance.view', orgId);
  return ctx.tx`
    select la.code, la.name, la.type, coalesce(sum(l.debit_minor), 0)::bigint as debit_minor, coalesce(sum(l.credit_minor), 0)::bigint as credit_minor
    from finance.ledger_accounts la
    left join finance.journal_lines l on l.ledger_account_id = la.id
    left join finance.journal_entries e on e.id = l.entry_id
    where la.org_id = ${orgId} and (e.id is null or e.entry_date <= ${asOf})
    group by la.code, la.name, la.type having coalesce(sum(l.debit_minor), 0) <> 0 or coalesce(sum(l.credit_minor), 0) <> 0
    order by la.code`;
}

export async function journal(ctx: Ctx, orgId: string, opts: { from: string; to: string; sourceType?: string | null }) {
  requirePerm(ctx, 'finance.view', orgId);
  return ctx.tx`
    select e.id, e.entry_date, e.memo, e.source_type, e.source_id, e.reverses_entry_id, e.created_at, lo.name as location_name,
      coalesce(p.display_name, p.full_name, u.username) as created_by_name,
      (select json_agg(json_build_object('code', la.code, 'account', la.name, 'debitMinor', l.debit_minor, 'creditMinor', l.credit_minor) order by l.id)
        from finance.journal_lines l join finance.ledger_accounts la on la.id = l.ledger_account_id where l.entry_id = e.id) as lines
    from finance.journal_entries e left join core.locations lo on lo.id = e.location_id
    left join core.users u on u.id = e.created_by left join core.people p on p.id = u.person_id
    where e.org_id = ${orgId} and e.entry_date between ${opts.from} and ${opts.to}
      and (${opts.sourceType ?? null}::text is null or e.source_type = ${opts.sourceType ?? null})
    order by e.created_at desc limit 500`;
}
