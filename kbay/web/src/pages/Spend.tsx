import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { get, post, qs } from '../api';
import {
  Badge, Button, Card, cx, Empty, ErrorText, Field, Input, Loading, Modal, Money, MoneyInput, PageHeader, Select, Stat, Table, Tabs,
  Textarea, useToast,
} from '../components/ui';
import { qtyDisplay, rs, timeLabel } from '../format';
import { useScope } from '../session';

// Spending: everyday expenses, stock bought from suppliers, and what is owed to suppliers (udhaar).
// Money is paisa throughout; quantities are decimal strings with a unit code.

type Dim = 'mass' | 'volume' | 'count';
const UNITS_BY_DIM: Record<Dim, string[]> = { mass: ['kg', 'g', 'maund', 'mg'], volume: ['l', 'ml'], count: ['unit', 'dozen'] };
const QTY_RE = /^\d+(\.\d{1,3})?$/;
const validQty = (q: string) => QTY_RE.test(q.trim()) && Number(q) > 0;

interface Head { id: string; code: string; name: string; type: string; system_key: string | null; is_expense_category: boolean; active: boolean }
interface Account { id: string; name: string; kind: string; location_id: string | null; active: boolean; balance_minor?: number | null }
interface Supplier { id: string; name: string; phone: string | null; notes: string | null; active: boolean; owed_minor: number }
interface StockItem { id: string; parent_id: string | null; name: string; category: string; kind: 'stock' | 'mix' | 'family'; dimension: Dim;
  purchase_unit: string; active: boolean }
interface ExpenseRow {
  id: string; location_name: string | null; amount_minor: number; payment: 'paid' | 'credit'; description: string; payee: string | null;
  status: string; created_at: string; category: string; account_name: string | null; supplier_name: string | null; created_by_name: string;
}
interface PurchaseRow {
  id: string; location_name: string; supplier_name: string; payment: 'paid' | 'credit'; total_minor: number; status: string; note: string | null;
  created_at: string; account_name: string | null; created_by_name: string;
  lines: { itemId: string; name: string; qty: string | number; unit: string; totalMinor: number }[] | null;
}

type Tab = 'expense' | 'purchase' | 'history' | 'suppliers';

const accountLabel = (a: Account) => (a.kind === 'cash' ? `Cash — ${a.name}` : a.name);

function useAccounts() {
  const { orgId } = useScope();
  return useQuery({ queryKey: ['accounts', orgId], queryFn: () => get<Account[]>(`/orgs/${orgId}/money-accounts`) });
}
function useSuppliers() {
  const { orgId } = useScope();
  return useQuery({ queryKey: ['suppliers', orgId], queryFn: () => get<Supplier[]>(`/orgs/${orgId}/suppliers`) });
}

export function Spend() {
  const { location, can } = useScope();
  const tabs = ([
    can('expense.create') && { value: 'expense', label: 'Log expense' },
    can('purchase.create') && { value: 'purchase', label: 'Stock in' },
    can('finance.view') && { value: 'history', label: 'History' },
    (can('supplier.manage') || can('supplier.pay') || can('finance.view')) && { value: 'suppliers', label: 'Suppliers' },
  ].filter(Boolean) as { value: Tab; label: string }[]);
  const [tab, setTab] = useState<Tab | null>(null);
  const current = tabs.find((t) => t.value === tab)?.value ?? tabs[0]?.value;

  if (!location) return <Empty>No location is set up for you yet.</Empty>;
  if (!current) return <><PageHeader title="Spend" /><Empty>You don't have access to spending here.</Empty></>;
  return (
    <>
      <PageHeader title="Spend" sub={`${location.name} · spends above ${rs(location.approval_limit_minor)} need a partner's approval`} />
      <Tabs tabs={tabs} value={current} onChange={setTab} />
      {current === 'expense' && <LogExpense />}
      {current === 'purchase' && <StockIn />}
      {current === 'history' && <History />}
      {current === 'suppliers' && <Suppliers />}
    </>
  );
}

/** Two or three big side-by-side choices (easier to tap than a dropdown). */
function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void;
  options: { value: T; label: string; sub?: string }[] }) {
  return (
    <div className={cx('grid gap-2', options.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {options.map((o) => (
        <button type="button" key={o.value} onClick={() => onChange(o.value)}
          className={cx('min-h-11 rounded-xl border px-3 py-2 text-left text-sm', value === o.value ? 'border-brand bg-brand/20 font-semibold' : 'border-[var(--line)] bg-[var(--panel-2)]')}>
          {o.label}
          {o.sub ? <div className="text-xs font-normal text-[var(--muted)]">{o.sub}</div> : null}
        </button>
      ))}
    </div>
  );
}

function ApprovalHint({ needs, children }: { needs: boolean; children: ReactNode }) {
  return (
    <div className={cx('rounded-xl p-3 text-sm', needs ? 'bg-amber-500/15' : 'bg-[var(--panel-2)] text-[var(--muted)]')}>
      {needs ? <Badge tone="warn">Needs approval</Badge> : null} {children}
    </div>
  );
}

// ---- Log expense ----

function LogExpense() {
  const { orgId, locationId, location, org } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const heads = useQuery({ queryKey: ['ledger-heads', orgId], queryFn: () => get<Head[]>(`/orgs/${orgId}/ledger-heads`) });
  const accounts = useAccounts();
  const suppliers = useSuppliers();
  const [scope, setScope] = useState<'location' | 'org'>('location');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [payment, setPayment] = useState<'paid' | 'credit'>('paid');
  const [account, setAccount] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [payee, setPayee] = useState('');
  const [description, setDescription] = useState('');

  const cats = (heads.data ?? []).filter((h) => h.is_expense_category && h.active);
  const payAccounts = (accounts.data ?? []).filter((a) => a.active && (scope === 'org' || a.location_id === locationId || a.kind !== 'cash'));
  const cashDefault = scope === 'location' ? payAccounts.find((a) => a.kind === 'cash' && a.location_id === locationId) : undefined;
  const payWith = payAccounts.some((a) => a.id === account) ? account : cashDefault?.id ?? '';
  const orgLimit = Number((org.settings as { approvalLimitMinor?: number }).approvalLimitMinor ?? 200000);
  const limit = scope === 'location' ? location?.approval_limit_minor ?? 0 : orgLimit;
  const overLimit = (amount ?? 0) > limit;
  const needs = payment === 'credit' || overLimit;

  const save = useMutation({
    mutationFn: () => post<{ id: string; status: 'posted' | 'pending_approval' }>(`/orgs/${orgId}/expenses`, {
      locationId: scope === 'location' ? locationId : null, categoryAccountId: category, amountMinor: amount, payment,
      moneyAccountId: payment === 'paid' ? payWith : null, supplierId: payment === 'credit' ? supplierId : null,
      payee: payee.trim() || null, description: description.trim(),
    }),
    onSuccess: (r) => {
      toast(r.status === 'posted' ? 'Logged' : 'Sent for approval');
      setAmount(null); setPayee(''); setDescription('');
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['day'] });
    },
  });
  const valid = category && (amount ?? 0) > 0 && description.trim().length >= 2 && (payment === 'paid' ? payWith : supplierId);

  if (heads.isLoading || accounts.isLoading) return <Loading />;
  return (
    <Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Field label="For">
            <Choice value={scope} onChange={setScope} options={[
              { value: 'location', label: location?.name ?? 'This location', sub: 'This stall or shop' },
              { value: 'org', label: 'Whole business', sub: 'Not tied to one location' },
            ]} />
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Pick a category"
              options={cats.map((h) => ({ value: h.id, label: h.name }))} />
          </Field>
          <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} placeholder="0" /></Field>
          <Field label="What was it for?">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. gas cylinder refill" />
          </Field>
        </div>
        <div className="space-y-4">
          <Field label="Payment">
            <Choice value={payment} onChange={setPayment} options={[
              { value: 'paid', label: 'Paid now', sub: 'From an account' },
              { value: 'credit', label: 'On credit', sub: 'Owed to a supplier' },
            ]} />
          </Field>
          {payment === 'paid' ? (
            <Field label="Paid from">
              <Select value={payWith} onChange={(e) => setAccount(e.target.value)} placeholder="Pick the account"
                options={payAccounts.map((a) => ({ value: a.id, label: accountLabel(a) }))} />
            </Field>
          ) : (
            <Field label="Supplier owed">
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="Pick the supplier"
                options={(suppliers.data ?? []).filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))} />
            </Field>
          )}
          <Field label="Paid to (optional)"><Input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Shop or person" /></Field>
          <ApprovalHint needs={needs}>
            {payment === 'credit' ? 'Anything on credit needs a partner\'s approval before it counts.'
              : overLimit ? `Above the ${scope === 'location' ? location?.name : 'business'} limit of ${rs(limit)}, so a partner must approve it.`
                : `Up to ${rs(limit)} is logged straight away.`}
          </ApprovalHint>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        <ErrorText error={save.error} />
        <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!valid} busy={save.isPending} onClick={() => save.mutate()}>
          {needs ? 'Send for approval' : 'Log expense'}{amount ? ` · ${rs(amount)}` : ''}
        </Button>
      </div>
    </Card>
  );
}

// ---- Stock in (purchase) ----

interface Line { key: string; itemId: string; qty: string; unit: string; total: number | null }
const newLine = (): Line => ({ key: crypto.randomUUID(), itemId: '', qty: '', unit: '', total: null });
const selectCls = 'h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 outline-none focus:border-brand focus:ring-2 focus:ring-brand/30';

/** Stock items grouped by category (only exact items that can be bought). */
function StockItemSelect({ items, value, onChange }: { items: StockItem[]; value: string; onChange: (id: string) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, StockItem[]>();
    for (const i of items) m.set(i.category, [...(m.get(i.category) ?? []), i]);
    return [...m.entries()];
  }, [items]);
  return (
    <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Item">
      <option value="">Pick an item</option>
      {groups.map(([cat, list]) => (
        <optgroup key={cat} label={cat}>
          {list.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function StockIn() {
  const { orgId, locationId, location, can } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const items = useQuery({ queryKey: ['stock-items', orgId], queryFn: () => get<StockItem[]>(`/orgs/${orgId}/stock-items`) });
  const accounts = useAccounts();
  const suppliers = useSuppliers();
  const [supplierId, setSupplierId] = useState('');
  const [adding, setAdding] = useState(false);
  const [payment, setPayment] = useState<'paid' | 'credit'>('paid');
  const [account, setAccount] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine()]);

  const buyable = (items.data ?? []).filter((i) => i.kind === 'stock' && i.active);
  const byId = new Map(buyable.map((i) => [i.id, i]));
  const payAccounts = (accounts.data ?? []).filter((a) => a.active && (a.location_id === locationId || a.kind !== 'cash'));
  const cashDefault = payAccounts.find((a) => a.kind === 'cash' && a.location_id === locationId);
  const payWith = payAccounts.some((a) => a.id === account) ? account : cashDefault?.id ?? '';
  const total = lines.reduce((a, l) => a + (l.total ?? 0), 0);
  const limit = location?.approval_limit_minor ?? 0;
  const needs = payment === 'credit' || total > limit;
  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const lineOk = (l: Line) => l.itemId && validQty(l.qty) && l.unit && (l.total ?? 0) > 0;
  const valid = supplierId && lines.length > 0 && lines.every(lineOk) && (payment === 'credit' || payWith);

  const save = useMutation({
    mutationFn: () => post<{ id: string; status: 'posted' | 'pending_approval'; totalMinor: number }>(`/orgs/${orgId}/purchases`, {
      locationId, supplierId, payment, moneyAccountId: payment === 'paid' ? payWith : null, note: note.trim() || null,
      lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty.trim(), unit: l.unit, totalMinor: l.total })),
    }),
    onSuccess: (r) => {
      toast(r.status === 'posted' ? `Logged · ${rs(r.totalMinor)}` : 'Sent for approval');
      setLines([newLine()]); setNote('');
      for (const k of ['purchases', 'stock', 'accounts', 'suppliers', 'approvals', 'day', 'movements']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });

  if (items.isLoading || accounts.isLoading || suppliers.isLoading) return <Loading />;
  if (items.error) return <ErrorText error={items.error} />;
  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <Field label="Supplier">
            <div className="flex gap-2">
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="Pick the supplier"
                options={(suppliers.data ?? []).filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))} />
              {can('supplier.manage') && <Button type="button" onClick={() => setAdding(true)} className="shrink-0">+ New</Button>}
            </div>
          </Field>
          <Field label="Payment">
            <Choice value={payment} onChange={setPayment} options={[
              { value: 'paid', label: 'Paid now', sub: 'From an account' },
              { value: 'credit', label: 'On credit', sub: 'Udhaar to supplier' },
            ]} />
          </Field>
          {payment === 'paid' && (
            <Field label="Paid from" className="lg:col-start-2">
              <Select value={payWith} onChange={(e) => setAccount(e.target.value)} placeholder="Pick the account"
                options={payAccounts.map((a) => ({ value: a.id, label: accountLabel(a) }))} />
            </Field>
          )}
        </div>
      </Card>

      <Card title="What was bought" actions={<Button size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>+ Add line</Button>}>
        {buyable.length === 0 ? <Empty>No stock items yet. Add them under Inventory → Items & recipes.</Empty> : (
          <div className="space-y-3">
            {lines.map((l, i) => {
              const it = byId.get(l.itemId);
              const units = it ? UNITS_BY_DIM[it.dimension] : [];
              return (
                <div key={l.key} className="rounded-xl border border-[var(--line)] p-3">
                  <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    <span>Line {i + 1}</span>
                    {lines.length > 1 && <button type="button" className="h-9 px-2 text-sm normal-case underline" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Remove</button>}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1.3fr]">
                    <StockItemSelect items={buyable} value={l.itemId}
                      onChange={(id) => setLine(l.key, { itemId: id, unit: byId.get(id)?.purchase_unit ?? '' })} />
                    <Input inputMode="decimal" placeholder="Qty" aria-label="Quantity" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })}
                      className={cx(l.qty && !validQty(l.qty) && 'border-[var(--bad)]')} />
                    <Select value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} aria-label="Unit" disabled={!it}
                      options={units.map((u) => ({ value: u, label: u }))} placeholder={it ? undefined : 'Unit'} />
                    <MoneyInput value={l.total} onChange={(v) => setLine(l.key, { total: v })} placeholder="Line total" aria-label="Line total" />
                  </div>
                  {it && validQty(l.qty) && (l.total ?? 0) > 0 && (
                    <div className="mt-1 text-xs text-[var(--muted)]">{rs(Math.round((l.total ?? 0) / Number(l.qty)))} per {l.unit}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-4 flex items-baseline justify-between border-t border-[var(--line)] pt-3">
          <span className="text-[var(--muted)]">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
          <span className="text-2xl font-bold tabular">{rs(total)}</span>
        </div>
      </Card>

      <Field label="Note (optional)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. bill no. 4411" /></Field>
      <ApprovalHint needs={needs}>
        {payment === 'credit' ? 'Buying on credit always needs a partner\'s approval. Stock is added once approved.'
          : total > limit ? `Above the ${location?.name} limit of ${rs(limit)}, so a partner must approve it. Stock is added once approved.`
            : `Up to ${rs(limit)} is logged straight away and the stock is added now.`}
      </ApprovalHint>
      <ErrorText error={save.error} />
      <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!valid} busy={save.isPending} onClick={() => save.mutate()}>
        {needs ? 'Send for approval' : 'Log stock in'} · {rs(total)}
      </Button>

      {adding && <SupplierModal onClose={() => setAdding(false)} onSaved={(id) => setSupplierId(id)} />}
    </div>
  );
}

// ---- History ----

function StatusBadge({ status }: { status: string }) {
  if (status === 'posted') return <Badge tone="good">Posted</Badge>;
  if (status === 'pending_approval') return <Badge tone="warn">Waiting approval</Badge>;
  if (status === 'rejected') return <Badge tone="bad">Rejected</Badge>;
  return <Badge>{status}</Badge>;
}

function History() {
  const { orgId, locationId, location } = useScope();
  const [scope, setScope] = useState<'here' | 'all'>('here');
  const loc = scope === 'here' ? locationId : undefined;
  const expenses = useQuery({ queryKey: ['expenses', orgId, loc ?? 'all'], queryFn: () => get<ExpenseRow[]>(`/orgs/${orgId}/expenses${qs({ locationId: loc })}`) });
  const purchases = useQuery({ queryKey: ['purchases', orgId, loc ?? 'all'], queryFn: () => get<PurchaseRow[]>(`/orgs/${orgId}/purchases${qs({ locationId: loc })}`) });
  const pendingTotal = [...(expenses.data ?? []).map((e) => (e.status === 'pending_approval' ? e.amount_minor : 0)),
    ...(purchases.data ?? []).map((p) => (p.status === 'pending_approval' ? p.total_minor : 0))].reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      <div className="max-w-md">
        <Choice value={scope} onChange={setScope} options={[{ value: 'here', label: location?.name ?? 'This location' }, { value: 'all', label: 'Everywhere' }]} />
      </div>
      {pendingTotal > 0 && <p className="text-sm text-[var(--muted)]"><Badge tone="warn">Waiting approval</Badge> {rs(pendingTotal)} in total</p>}
      <Card title="Expenses">
        {expenses.isLoading ? <Loading /> : expenses.error ? <ErrorText error={expenses.error} /> : (
          <Table rows={expenses.data ?? []} rowKey={(r) => r.id} empty="No expenses yet."
            columns={[
              { label: 'When', render: (r) => timeLabel(r.created_at) },
              { label: 'What', render: (r) => <span><b className="font-medium">{r.category}</b> · {r.description}{r.payee ? ` (${r.payee})` : ''}</span> },
              { label: 'Paid', render: (r) => (r.payment === 'credit' ? `Credit · ${r.supplier_name ?? '—'}` : r.account_name ?? '—') },
              ...(scope === 'all' ? [{ label: 'Location', render: (r: ExpenseRow) => r.location_name ?? 'Whole business', hideOnMobile: true }] : []),
              { label: 'By', render: (r) => r.created_by_name, hideOnMobile: true },
              { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { label: 'Amount', align: 'right', render: (r) => <Money minor={r.amount_minor} className="font-semibold" /> },
            ]} />
        )}
      </Card>
      <Card title="Stock bought">
        {purchases.isLoading ? <Loading /> : purchases.error ? <ErrorText error={purchases.error} /> : (
          <Table rows={purchases.data ?? []} rowKey={(r) => r.id} empty="No purchases yet."
            columns={[
              { label: 'When', render: (r) => timeLabel(r.created_at) },
              { label: 'Supplier', render: (r) => r.supplier_name },
              { label: 'Items', render: (r) => (r.lines ?? []).map((l) => `${l.name} ${qtyDisplay(l.qty, l.unit)}`).join(', ') },
              { label: 'Paid', render: (r) => (r.payment === 'credit' ? 'Credit' : r.account_name ?? '—') },
              ...(scope === 'all' ? [{ label: 'Location', render: (r: PurchaseRow) => r.location_name, hideOnMobile: true }] : []),
              { label: 'By', render: (r) => r.created_by_name, hideOnMobile: true },
              { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { label: 'Total', align: 'right', render: (r) => <Money minor={r.total_minor} className="font-semibold" /> },
            ]} />
        )}
      </Card>
    </div>
  );
}

// ---- Suppliers ----

function Suppliers() {
  const { can } = useScope();
  const suppliers = useSuppliers();
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [paying, setPaying] = useState<Supplier | null>(null);
  const list = suppliers.data ?? [];
  const owed = list.reduce((a, s) => a + s.owed_minor, 0);

  if (suppliers.isLoading) return <Loading />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Owed to suppliers" value={rs(owed)} sub="Udhaar still to pay" tone={owed > 0 ? 'bad' : undefined} />
        <Stat label="Suppliers" value={list.filter((s) => s.active).length} />
      </div>
      <Card title="Suppliers" actions={can('supplier.manage') ? <Button size="sm" variant="primary" onClick={() => setEditing('new')}>+ Add supplier</Button> : null}>
        <ErrorText error={suppliers.error} />
        <Table rows={list} rowKey={(r) => r.id} empty="No suppliers yet."
          columns={[
            { label: 'Name', render: (r) => <span className="font-medium">{r.name} {!r.active && <Badge>Off</Badge>}</span> },
            { label: 'Phone', render: (r) => (r.phone ? <a className="underline" href={`tel:${r.phone}`}>{r.phone}</a> : '—') },
            { label: 'Notes', render: (r) => r.notes ?? '', hideOnMobile: true },
            { label: 'Owed', align: 'right', render: (r) => (r.owed_minor > 0 ? <Money minor={r.owed_minor} className="font-semibold text-[var(--bad)]" /> : <Money minor={r.owed_minor} />) },
            { label: '', render: (r) => (
              <span className="flex justify-end gap-2">
                {can('supplier.pay') && r.owed_minor > 0 && <Button size="sm" variant="primary" onClick={() => setPaying(r)}>Pay</Button>}
                {can('supplier.manage') && <Button size="sm" onClick={() => setEditing(r)}>Edit</Button>}
              </span>
            ) },
          ]} />
      </Card>
      {editing && <SupplierModal supplier={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {paying && <PaySupplier supplier={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}

function SupplierModal({ supplier, onClose, onSaved }: { supplier?: Supplier; onClose: () => void; onSaved?: (id: string) => void }) {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [notes, setNotes] = useState(supplier?.notes ?? '');
  const [active, setActive] = useState(supplier?.active ?? true);
  const save = useMutation({
    mutationFn: () => post<{ id: string }>(`/orgs/${orgId}/suppliers`, {
      id: supplier?.id, name: name.trim(), phone: phone.trim() || null, notes: notes.trim() || null, active,
    }),
    onSuccess: (r) => {
      toast(supplier ? 'Supplier saved' : 'Supplier added');
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      onSaved?.(r.id);
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={supplier ? `Edit ${supplier.name}` : 'Add supplier'}
      footer={<Button variant="primary" disabled={name.trim().length < 2} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="space-y-3">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Haji potato wala" /></Field>
        <Field label="Phone (optional)"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="03xx xxxxxxx" /></Field>
        <Field label="Notes (optional)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What they sell, where" /></Field>
        {supplier && (
          <label className="flex h-11 items-center gap-3">
            <input type="checkbox" className="h-5 w-5 accent-brand" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span>Active (shown when buying)</span>
          </label>
        )}
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

function PaySupplier({ supplier, onClose }: { supplier: Supplier; onClose: () => void }) {
  const { orgId, locationId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = useAccounts();
  const [amount, setAmount] = useState<number | null>(supplier.owed_minor);
  const [account, setAccount] = useState('');
  const [note, setNote] = useState('');
  const payAccounts = (accounts.data ?? []).filter((a) => a.active && (a.location_id === locationId || a.kind !== 'cash'));
  const over = (amount ?? 0) > supplier.owed_minor;
  const pay = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/suppliers/${supplier.id}/pay`, { amountMinor: amount, moneyAccountId: account, locationId, note: note.trim() || undefined }),
    onSuccess: () => {
      toast(`Paid ${supplier.name} ${rs(amount)}`);
      for (const k of ['suppliers', 'accounts', 'day']) void qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={`Pay ${supplier.name}`}
      footer={<Button variant="primary" disabled={!amount || over || !account} busy={pay.isPending} onClick={() => pay.mutate()}>Pay {rs(amount)}</Button>}>
      <div className="space-y-3">
        <p className="text-sm text-[var(--muted)]">Owed now: <b className="text-[var(--ink)]">{rs(supplier.owed_minor)}</b></p>
        <Field label="Amount" hint={over ? <span className="text-[var(--bad)]">More than is owed.</span> : undefined}>
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
        <Field label="Paid from">
          <Select value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Pick the account"
            options={payAccounts.map((a) => ({ value: a.id, label: accountLabel(a) }))} />
        </Field>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorText error={pay.error} />
      </div>
    </Modal>
  );
}
