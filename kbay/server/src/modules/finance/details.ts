import type { Ctx } from '../../core/context.js';
import { dayFigures } from './days.js';

// What an approver sees behind each request, so they decide on the facts, not only a summary.

export async function expense(ctx: Ctx, id: string) {
  const [x] = await ctx.tx`
    select x.amount_minor, x.payment, x.description, x.payee, x.status, x.created_at, la.name as category, ma.name as account_name,
      s.name as supplier_name, l.name as location_name, l.approval_limit_minor
    from finance.expenses x join finance.ledger_accounts la on la.id = x.category_account_id
    left join finance.money_accounts ma on ma.id = x.money_account_id left join finance.suppliers s on s.id = x.supplier_id
    left join core.locations l on l.id = x.location_id where x.id = ${id}`;
  return x ? { type: 'expense', ...x } : null;
}

export async function purchase(ctx: Ctx, id: string) {
  const [p] = await ctx.tx`
    select p.total_minor, p.payment, p.note, p.status, p.created_at, s.name as supplier_name, ma.name as account_name,
      l.name as location_name, l.approval_limit_minor,
      (select coalesce(sum(jl.credit_minor - jl.debit_minor), 0)::bigint from finance.journal_lines jl
        join finance.ledger_accounts la on la.id = jl.ledger_account_id where la.system_key = 'payables' and jl.supplier_id = p.supplier_id) as supplier_owed_minor,
      (select json_agg(json_build_object('name', i.name, 'qty', pl.qty, 'unit', pl.unit, 'totalMinor', pl.total_minor) order by i.name)
        from finance.purchase_lines pl join inventory.items i on i.id = pl.item_id where pl.purchase_id = p.id) as lines
    from finance.purchases p join finance.suppliers s on s.id = p.supplier_id left join finance.money_accounts ma on ma.id = p.money_account_id
    join core.locations l on l.id = p.location_id where p.id = ${id}`;
  return p ? { type: 'purchase', ...p } : null;
}

export async function day(ctx: Ctx, id: string) {
  const [d] = await ctx.tx`select d.business_date, d.opening_float_minor, d.closing_note, d.submitted_at, l.name as location_name
    from finance.business_days d join core.locations l on l.id = d.location_id where d.id = ${id}`;
  if (!d) return null;
  const lines = await ctx.tx`select m.name, m.kind, c.expected_minor, c.declared_minor, (c.declared_minor - c.expected_minor)::bigint as difference_minor
    from finance.day_close_lines c join finance.money_accounts m on m.id = c.money_account_id where c.business_day_id = ${id} order by m.kind, m.name`;
  return { type: 'day_close', ...d, figures: await dayFigures(ctx.tx, id), lines };
}

export async function capital(ctx: Ctx, id: string) {
  const [t] = await ctx.tx`select t.kind, t.amount_minor, t.reason, t.status, coalesce(p.display_name, p.full_name) as person_name,
      m.name as account_name, lo.principal_minor as loan_principal_minor, lo.due_date as loan_due_date
    from finance.capital_txns t join core.people p on p.id = t.person_id left join finance.money_accounts m on m.id = t.money_account_id
    left join finance.loans lo on lo.id = t.loan_id where t.id = ${id}`;
  return t ? { type: 'capital', ...t } : null;
}

export async function shares(ctx: Ctx, id: string) {
  const [p] = await ctx.tx<{ shares: { personId: string; weight: number }[]; effective_from: string; reason: string | null; org_id: string }[]>`
    select shares, effective_from, reason, org_id from finance.partner_share_proposals where id = ${id}`;
  if (!p) return null;
  const names = await ctx.tx<{ id: string; name: string }[]>`select id, coalesce(display_name, full_name) as name from core.people
    where id = any(${p.shares.map((s) => s.personId)}::uuid[])`;
  const total = p.shares.reduce((a, s) => a + s.weight, 0);
  const current = await ctx.tx`select coalesce(pp.display_name, pp.full_name) as name, s.weight::text as weight
    from finance.partner_shares s join core.people pp on pp.id = s.person_id where s.org_id = ${p.org_id} and s.effective_to is null`;
  return {
    type: 'shares', effective_from: p.effective_from, reason: p.reason, current,
    proposed: p.shares.map((s) => ({ name: names.find((n) => n.id === s.personId)?.name ?? '?', percent: Math.round((s.weight / total) * 10000) / 100 })),
  };
}
