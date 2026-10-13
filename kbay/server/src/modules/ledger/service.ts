import { badRequest } from '../../core/errors.js';
import { assertInt } from '../../core/math.js';
import type { Tx } from '../../db/db.js';

// Default chart of accounts (account heads), kept light and grown as needed.
// system_key heads are posted to by code; is_expense_category heads appear in the expense form.
export const DEFAULT_CHART: { code: string; name: string; type: string; key?: string; category?: boolean }[] = [
  { code: '1300', name: 'Inventory (stock on hand)', type: 'asset', key: 'inventory' },
  { code: '1400', name: 'Advances to people (borrowed)', type: 'asset', key: 'advances' },
  { code: '2000', name: 'Supplier payables (udhaar)', type: 'liability', key: 'payables' },
  { code: '2100', name: 'Tax payable', type: 'liability', key: 'tax_payable' },
  { code: '2200', name: 'Loans from investors', type: 'liability', key: 'loans' },
  { code: '2300', name: 'Wages and commission payable', type: 'liability', key: 'wages_payable' },
  { code: '3000', name: 'Capital invested', type: 'equity', key: 'capital' },
  { code: '3200', name: 'Withdrawals and payouts', type: 'equity', key: 'drawings' },
  { code: '3300', name: 'Profit reinvested', type: 'equity', key: 'reinvested' },
  { code: '4000', name: 'Sales', type: 'revenue', key: 'sales' },
  { code: '4100', name: 'Sales refunds', type: 'revenue', key: 'sales_returns' },
  { code: '5000', name: 'Cost of food sold', type: 'expense', key: 'cogs_food' },
  { code: '5010', name: 'Cost of beverages sold', type: 'expense', key: 'cogs_beverage' },
  { code: '5020', name: 'Packaging used', type: 'expense', key: 'cogs_packaging' },
  { code: '5030', name: 'Gas and fuel used', type: 'expense', key: 'cogs_fuel' },
  { code: '5100', name: 'Food waste', type: 'expense', key: 'waste_food' },
  { code: '5110', name: 'Beverage waste', type: 'expense', key: 'waste_beverage' },
  { code: '5120', name: 'Other losses and breakage', type: 'expense', key: 'waste_other' },
  { code: '5200', name: 'Stock count difference', type: 'expense', key: 'stock_variance' },
  { code: '5300', name: 'Cash over / short', type: 'expense', key: 'cash_over_short' },
  { code: '6000', name: 'Wages', type: 'expense', key: 'wages' },
  { code: '6010', name: 'Sales commission', type: 'expense', key: 'commission' },
  { code: '6100', name: 'Rent and stall fees', type: 'expense', category: true },
  { code: '6200', name: 'Repairs and maintenance', type: 'expense', category: true },
  { code: '6300', name: 'Electricity and utilities', type: 'expense', category: true },
  { code: '6400', name: 'Transport and delivery', type: 'expense', category: true },
  { code: '6500', name: 'Marketing and printing', type: 'expense', category: true },
  { code: '6600', name: 'Payment and bank fees', type: 'expense', category: true },
  { code: '6700', name: 'Equipment (small)', type: 'expense', category: true },
  { code: '6800', name: 'Staff food and tea', type: 'expense', category: true },
  { code: '6900', name: 'Other expenses', type: 'expense', category: true },
];

export async function createDefaultChart(tx: Tx, tenantId: string, orgId: string) {
  for (const a of DEFAULT_CHART) {
    await tx`insert into finance.ledger_accounts (tenant_id, org_id, code, name, type, system_key, is_expense_category)
      values (${tenantId}, ${orgId}, ${a.code}, ${a.name}, ${a.type}, ${a.key ?? null}, ${a.category ?? false})
      on conflict (org_id, code) do nothing`;
  }
}

export type SystemKey =
  | 'inventory' | 'advances' | 'payables' | 'tax_payable' | 'loans' | 'wages_payable' | 'capital' | 'drawings'
  | 'reinvested' | 'sales' | 'sales_returns' | 'cogs_food' | 'cogs_beverage' | 'cogs_packaging' | 'cogs_fuel'
  | 'waste_food' | 'waste_beverage' | 'waste_other' | 'stock_variance' | 'cash_over_short' | 'wages' | 'commission';

export async function accountId(tx: Tx, orgId: string, key: SystemKey): Promise<string> {
  const [r] = await tx<{ id: string }[]>`select id from finance.ledger_accounts where org_id = ${orgId} and system_key = ${key}`;
  if (!r) throw new Error(`chart of accounts is missing ${key} for org ${orgId}`);
  return r.id;
}

export interface JournalLine {
  account: string;
  debit?: number;
  credit?: number;
  locationId?: string | null;
  moneyAccountId?: string | null;
  personId?: string | null;
  supplierId?: string | null;
  memo?: string | null;
}

export interface JournalEntry {
  tenantId: string;
  orgId: string;
  locationId?: string | null;
  businessDayId?: string | null;
  entryDate: string;
  memo: string;
  sourceType: string;
  sourceId?: string | null;
  reversesEntryId?: string | null;
  createdBy?: string | null;
  lines: JournalLine[];
}

/**
 * Post a balanced double-entry journal entry. Zero lines are dropped. The database re-checks the
 * balance at commit, and posted entries can never be edited — only reversed.
 */
export async function postEntry(tx: Tx, e: JournalEntry): Promise<string> {
  const lines = e.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  let d = 0;
  let c = 0;
  for (const l of lines) {
    const debit = l.debit ?? 0;
    const credit = l.credit ?? 0;
    assertInt(debit, 'debit');
    assertInt(credit, 'credit');
    if (debit < 0 || credit < 0) throw new Error('journal amounts must be non-negative');
    if (debit > 0 && credit > 0) throw new Error('a journal line is either a debit or a credit');
    d += debit;
    c += credit;
  }
  if (lines.length < 2) throw badRequest('empty_entry', 'Nothing to post.');
  if (d !== c) throw new Error(`unbalanced entry: debits ${d} credits ${c} (${e.memo})`);
  const created = e.createdBy && e.createdBy !== '00000000-0000-0000-0000-000000000000' ? e.createdBy : null;
  const [row] = await tx<{ id: string }[]>`
    insert into finance.journal_entries (tenant_id, org_id, location_id, business_day_id, entry_date, memo, source_type, source_id,
      reverses_entry_id, created_by)
    values (${e.tenantId}, ${e.orgId}, ${e.locationId ?? null}, ${e.businessDayId ?? null}, ${e.entryDate}, ${e.memo},
      ${e.sourceType}, ${e.sourceId ?? null}, ${e.reversesEntryId ?? null}, ${created})
    returning id`;
  const entryId = row!.id;
  for (const l of lines) {
    await tx`insert into finance.journal_lines (tenant_id, entry_id, ledger_account_id, debit_minor, credit_minor, location_id,
        money_account_id, person_id, supplier_id, memo)
      values (${e.tenantId}, ${entryId}, ${l.account}, ${l.debit ?? 0}, ${l.credit ?? 0}, ${l.locationId ?? e.locationId ?? null},
        ${l.moneyAccountId ?? null}, ${l.personId ?? null}, ${l.supplierId ?? null}, ${l.memo ?? null})`;
  }
  return entryId;
}

/** Post the exact mirror of an earlier entry (used for voids and corrections). */
export async function reverseEntry(tx: Tx, entryId: string, opts: { memo: string; sourceType: string; sourceId?: string;
  businessDayId?: string | null; entryDate: string; createdBy?: string | null }): Promise<string> {
  const [e] = await tx<{ tenant_id: string; org_id: string; location_id: string | null }[]>`
    select tenant_id, org_id, location_id from finance.journal_entries where id = ${entryId}`;
  if (!e) throw new Error(`entry ${entryId} not found`);
  const lines = await tx<{ ledger_account_id: string; debit_minor: number; credit_minor: number; location_id: string | null;
    money_account_id: string | null; person_id: string | null; supplier_id: string | null; memo: string | null }[]>`
    select ledger_account_id, debit_minor, credit_minor, location_id, money_account_id, person_id, supplier_id, memo
    from finance.journal_lines where entry_id = ${entryId} order by id`;
  return postEntry(tx, {
    tenantId: e.tenant_id,
    orgId: e.org_id,
    locationId: e.location_id,
    businessDayId: opts.businessDayId ?? null,
    entryDate: opts.entryDate,
    memo: opts.memo,
    sourceType: opts.sourceType,
    sourceId: opts.sourceId ?? null,
    reversesEntryId: entryId,
    createdBy: opts.createdBy ?? null,
    lines: lines.map((l) => ({
      account: l.ledger_account_id,
      debit: l.credit_minor,
      credit: l.debit_minor,
      locationId: l.location_id,
      moneyAccountId: l.money_account_id,
      personId: l.person_id,
      supplierId: l.supplier_id,
      memo: l.memo,
    })),
  });
}

/** Debit-positive balance of a ledger account (assets/expenses positive; liabilities/equity/revenue negative). */
export async function balance(tx: Tx, ledgerAccountId: string, opts: { personId?: string; supplierId?: string; upToDate?: string } = {}) {
  const [r] = await tx<{ b: number }[]>`
    select coalesce(sum(l.debit_minor - l.credit_minor), 0)::bigint as b
    from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
    where l.ledger_account_id = ${ledgerAccountId}
      and (${opts.personId ?? null}::uuid is null or l.person_id = ${opts.personId ?? null})
      and (${opts.supplierId ?? null}::uuid is null or l.supplier_id = ${opts.supplierId ?? null})
      and (${opts.upToDate ?? null}::date is null or e.entry_date <= ${opts.upToDate ?? null})`;
  return r?.b ?? 0;
}

/** The original (non-reversal) entry posted for a source record, if any. */
export async function findEntry(tx: Tx, sourceType: string, sourceId: string): Promise<string | null> {
  const [r] = await tx<{ id: string }[]>`select id from finance.journal_entries
    where source_type = ${sourceType} and source_id = ${sourceId} and reverses_entry_id is null order by created_at limit 1`;
  return r?.id ?? null;
}
