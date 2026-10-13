import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { get, post, put, qs } from '../api';
import {
  Badge, Button, Card, cx, Empty, ErrorText, Field, Input, Loading, Modal, Money, PageHeader, Select, Stat, Table, Tabs, Textarea, useToast,
} from '../components/ui';
import { dateLabel, qtyDisplay, rs, timeLabel } from '../format';
import { useScope } from '../session';

// Stock on hand, requests, waste, the weekly count, and the items/recipes that drive theoretical usage.
// The server keeps quantities in base units (g, ml, unit); the screen shows each item in its purchase unit.

type Dim = 'mass' | 'volume' | 'count';
type Kind = 'stock' | 'mix' | 'family';
type Stage = 'prep' | 'fry' | 'serve';

/** Base units (g / ml / unit) in one of each unit. */
const UNITS: Record<string, { dim: Dim; base: number }> = {
  mg: { dim: 'mass', base: 0.001 }, g: { dim: 'mass', base: 1 }, kg: { dim: 'mass', base: 1000 }, maund: { dim: 'mass', base: 40000 },
  ml: { dim: 'volume', base: 1 }, l: { dim: 'volume', base: 1000 },
  unit: { dim: 'count', base: 1 }, dozen: { dim: 'count', base: 12 },
};
const UNITS_BY_DIM: Record<Dim, string[]> = { mass: ['kg', 'g', 'maund', 'mg'], volume: ['l', 'ml'], count: ['unit', 'dozen'] };
const BASE_UNIT: Record<Dim, string> = { mass: 'g', volume: 'ml', count: 'unit' };
const DIM_LABEL: Record<Dim, string> = { mass: 'Weight', volume: 'Volume', count: 'Count' };
const QTY_RE = /^\d+(\.\d{1,3})?$/;
const validQty = (q: string) => QTY_RE.test(q.trim()) && Number(q) > 0;
/** A base-unit amount shown in another unit (e.g. 1500 g -> "1.5 kg"). */
const inUnit = (base: number | string | null | undefined, unit: string) => qtyDisplay(Number(base ?? 0) / (UNITS[unit]?.base ?? 1), unit);
/** Same, as a plain editable string with up to 3 decimals. */
const toUnitStr = (base: number | string, unit: string) => String(Math.round((Number(base) / (UNITS[unit]?.base ?? 1)) * 1000) / 1000);

interface StockItem {
  id: string; parent_id: string | null; name: string; category: string; kind: Kind; dimension: Dim; purchase_unit: string;
  tracking: 'precise' | 'bulk'; cost_class: 'food' | 'beverage' | 'packaging' | 'fuel'; low_stock_base: string | null; active: boolean;
  components: { itemId: string; per1000Base: number | string }[];
}
interface Level {
  id: string; name: string; category: string; parent_id: string | null; dimension: Dim; purchase_unit: string; tracking: string;
  qty_display: string; value_minor: number; is_low: boolean;
}
interface Movement { id: string; item_id: string; qty_base: string; value_minor: number; reason: string; note: string | null; created_at: string }
interface Price { created_at: string; supplier_name: string; qty: string | number; unit: string; total_minor: number; unit_price_minor: number }
interface StockRequest {
  id: string; location_id: string; location_name: string; item_id: string | null; item_name: string | null; note: string; status: string;
  created_at: string; closed_at: string | null; requested_by_name: string;
}
interface CountLine { itemId: string; name: string; expected: string | number; counted: string | number; diff: string | number; valueMinor: number }
interface CountRow { id: string; created_at: string; note: string | null; counted_by: string; variance_minor: number; lines: CountLine[] | null }

type Tab = 'stock' | 'requests' | 'waste' | 'count' | 'items';

function useItems() {
  const { orgId } = useScope();
  return useQuery({ queryKey: ['stock-items', orgId], queryFn: () => get<StockItem[]>(`/orgs/${orgId}/stock-items`) });
}

export function Inventory() {
  const { location, can } = useScope();
  const tabs = ([
    can('inventory.view') && { value: 'stock', label: 'Stock' },
    (can('inventory.view') || can('inventory.request')) && { value: 'requests', label: 'Requests' },
    can('inventory.waste') && { value: 'waste', label: 'Waste' },
    can('inventory.count') && { value: 'count', label: 'Weekly count' },
    can('inventory.manage') && { value: 'items', label: 'Items & recipes' },
  ].filter(Boolean) as { value: Tab; label: string }[]);
  const [tab, setTab] = useState<Tab | null>(null);
  const current = tabs.find((t) => t.value === tab)?.value ?? tabs[0]?.value;

  if (!location) return <Empty>No location is set up for you yet.</Empty>;
  if (!current) return <><PageHeader title="Stock" /><Empty>You don't have access to stock here.</Empty></>;
  return (
    <>
      <PageHeader title="Stock" sub={location.name} />
      <Tabs tabs={tabs} value={current} onChange={setTab} />
      {current === 'stock' && <StockLevels />}
      {current === 'requests' && <Requests />}
      {current === 'waste' && <Waste />}
      {current === 'count' && <WeeklyCount />}
      {current === 'items' && <ItemsAndRecipes />}
    </>
  );
}

const selectCls = 'h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 outline-none focus:border-brand focus:ring-2 focus:ring-brand/30';

/** Items grouped by category in a native select (optgroups read well on phones). */
function ItemSelect({ items, value, onChange, placeholder = 'Pick an item', label = 'Item' }: {
  items: StockItem[]; value: string; onChange: (id: string) => void; placeholder?: string; label?: string }) {
  const groups = useMemo(() => groupBy(items, (i) => i.category), [items]);
  return (
    <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{placeholder}</option>
      {groups.map(([cat, list]) => (
        <optgroup key={cat} label={cat}>
          {list.map((i) => <option key={i.id} value={i.id}>{i.name}{i.kind === 'mix' ? ' (mix)' : i.kind === 'family' ? ' (any variety)' : ''}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function groupBy<T>(rows: T[], key: (r: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return [...m.entries()];
}

function UnitSelect({ dim, value, onChange }: { dim: Dim | undefined; value: string; onChange: (u: string) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Unit" disabled={!dim}
      options={(dim ? UNITS_BY_DIM[dim] : []).map((u) => ({ value: u, label: u }))} placeholder={dim ? undefined : 'Unit'} />
  );
}

function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button type="button" key={o.value} onClick={() => onChange(o.value)}
          className={cx('h-11 rounded-xl border px-4 text-sm', value === o.value ? 'border-brand bg-brand/20 font-semibold' : 'border-[var(--line)] bg-[var(--panel-2)]')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- Stock levels ----

const REASON: Record<string, string> = {
  purchase: 'Bought', sale: 'Sold', void: 'Sale voided', waste: 'Waste', count_adjust: 'Count adjustment', opening: 'Opening stock', correction: 'Correction',
};

function StockLevels() {
  const { orgId, locationId } = useScope();
  const stock = useQuery({ queryKey: ['stock', orgId, locationId], queryFn: () => get<Level[]>(`/orgs/${orgId}/stock${qs({ locationId })}`) });
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [open, setOpen] = useState<Level | null>(null);
  if (stock.isLoading) return <Loading />;
  if (stock.error) return <ErrorText error={stock.error} />;
  const rows = stock.data ?? [];
  const value = rows.reduce((a, r) => a + r.value_minor, 0);
  const low = rows.filter((r) => r.is_low).length;
  const shown = rows.filter((r) => (!lowOnly || r.is_low) && r.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Stock value" value={rs(value)} sub="At average cost" />
        <Stat label="Running low" value={low} tone={low > 0 ? 'bad' : undefined} sub={low > 0 ? 'Raise a request or buy more' : 'All fine'} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Search items" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search items" />
        <Button variant={lowOnly ? 'primary' : 'secondary'} onClick={() => setLowOnly((v) => !v)}>Low only</Button>
      </div>
      {shown.length === 0 ? <Empty>{rows.length === 0 ? 'No stock items yet.' : 'Nothing matches.'}</Empty> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groupBy(shown, (r) => r.category).map(([cat, list]) => (
            <Card key={cat} title={cat}>
              <div className="divide-y divide-[var(--line)]">
                {list.map((r) => (
                  <button key={r.id} onClick={() => setOpen(r)} className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left hover:bg-[var(--panel-2)]">
                    <span className="min-w-0">
                      <span className="font-medium">{r.name}</span> {r.is_low && <Badge tone="bad">Low</Badge>}
                      {r.tracking === 'bulk' && <span className="block text-xs text-[var(--muted)]">Bulk (estimated)</span>}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className={cx('block font-semibold tabular', Number(r.qty_display) < 0 && 'text-[var(--bad)]')}>{qtyDisplay(r.qty_display, r.purchase_unit)}</span>
                      <span className="block text-xs text-[var(--muted)]"><Money minor={r.value_minor} /></span>
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
      {open && <ItemDetail level={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ItemDetail({ level, onClose }: { level: Level; onClose: () => void }) {
  const { orgId, locationId, can } = useScope();
  const moves = useQuery({ queryKey: ['movements', orgId, locationId, level.id],
    queryFn: () => get<Movement[]>(`/orgs/${orgId}/stock/movements${qs({ locationId, itemId: level.id })}`) });
  const prices = useQuery({ queryKey: ['prices', orgId, level.id], queryFn: () => get<Price[]>(`/orgs/${orgId}/stock-items/${level.id}/prices`),
    enabled: can('finance.view') });
  return (
    <Modal open onClose={onClose} title={level.name} wide>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="On hand" value={qtyDisplay(level.qty_display, level.purchase_unit)} />
          <Stat label="Value" value={rs(level.value_minor)} />
        </div>
        <div>
          <h3 className="mb-2 font-semibold">Recent movements</h3>
          {moves.isLoading ? <Loading /> : (
            <Table rows={(moves.data ?? []).slice(0, 50)} rowKey={(r) => r.id} empty="No movements yet."
              columns={[
                { label: 'When', render: (r) => timeLabel(r.created_at) },
                { label: 'What', render: (r) => <span>{REASON[r.reason] ?? r.reason}{r.note ? <span className="text-[var(--muted)]"> · {r.note}</span> : null}</span> },
                { label: 'Qty', align: 'right', render: (r) => (
                  <span className={cx(Number(r.qty_base) < 0 ? 'text-[var(--bad)]' : 'text-[var(--good)]')}>
                    {Number(r.qty_base) > 0 ? '+' : Number(r.qty_base) < 0 ? '−' : ''}{inUnit(Math.abs(Number(r.qty_base)), level.purchase_unit)}
                  </span>) },
                { label: 'Value', align: 'right', render: (r) => <Money minor={r.value_minor} sign /> },
              ]} />
          )}
          <ErrorText error={moves.error} />
        </div>
        {can('finance.view') && (
          <div>
            <h3 className="mb-2 font-semibold">Price paid</h3>
            {prices.isLoading ? <Loading /> : (
              <Table rows={prices.data ?? []} rowKey={(r) => `${r.created_at}-${r.supplier_name}-${r.total_minor}`} empty="Not bought yet."
                columns={[
                  { label: 'Date', render: (r) => dateLabel(r.created_at) },
                  { label: 'Supplier', render: (r) => r.supplier_name },
                  { label: 'Bought', render: (r) => qtyDisplay(r.qty, r.unit), hideOnMobile: true },
                  { label: 'Total', align: 'right', render: (r) => <Money minor={r.total_minor} />, hideOnMobile: true },
                  { label: 'Price', align: 'right', render: (r) => <span className="font-semibold">{rs(r.unit_price_minor)} / {r.unit}</span> },
                ]} />
            )}
            <ErrorText error={prices.error} />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---- Stock requests ----

function Requests() {
  const { orgId, locationId, location, can } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'done' | 'cancelled' | 'all'>('open');
  const reqs = useQuery({ queryKey: ['stock-requests', orgId, status], queryFn: () => get<StockRequest[]>(`/orgs/${orgId}/stock-requests${qs({ status })}`),
    enabled: can('inventory.view') });
  const items = useItems();
  const [itemId, setItemId] = useState('');
  const [note, setNote] = useState('');
  const raise = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/stock-requests`, { locationId, itemId: itemId || null, note: note.trim() }),
    onSuccess: () => {
      toast('Request raised');
      setItemId(''); setNote('');
      void qc.invalidateQueries({ queryKey: ['stock-requests'] });
    },
  });
  const close = useMutation({
    mutationFn: (v: { id: string; status: 'done' | 'cancelled' }) => post(`/orgs/${orgId}/stock-requests/${v.id}/close`, { status: v.status }),
    onSuccess: (_r, v) => {
      toast(v.status === 'done' ? 'Marked done' : 'Cancelled');
      void qc.invalidateQueries({ queryKey: ['stock-requests'] });
    },
    onError: (e) => toast(e.message, 'bad'),
  });
  const here = (reqs.data ?? []).filter((r) => r.location_id === locationId);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card title={`Requests at ${location?.name ?? 'this location'}`}>
        <div className="mb-3">
          <Choice value={status} onChange={setStatus} options={[
            { value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' },
          ]} />
        </div>
        {!can('inventory.view') ? <Empty>You can raise requests but not see the list.</Empty> : reqs.isLoading ? <Loading /> : (
          <div className="space-y-2">
            <ErrorText error={reqs.error} />
            {here.length === 0 ? <Empty>No {status === 'all' ? '' : status} requests.</Empty> : here.map((r) => (
              <div key={r.id} className="rounded-xl border border-[var(--line)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium">{r.item_name ?? 'General'}</div>
                    <div className="text-sm">{r.note}</div>
                    <div className="mt-1 text-xs text-[var(--muted)]">{r.requested_by_name} · {timeLabel(r.created_at)}</div>
                  </div>
                  <Badge tone={r.status === 'open' ? 'warn' : r.status === 'done' ? 'good' : 'neutral'}>{r.status === 'open' ? 'Open' : r.status === 'done' ? 'Done' : 'Cancelled'}</Badge>
                </div>
                {r.status === 'open' && can('inventory.request') && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="good" disabled={close.isPending} onClick={() => close.mutate({ id: r.id, status: 'done' })}>Done</Button>
                    <Button size="sm" disabled={close.isPending} onClick={() => close.mutate({ id: r.id, status: 'cancelled' })}>Cancel</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {can('inventory.request') && (
        <Card title="Raise a request" className="self-start">
          <div className="space-y-3">
            <Field label="Item (optional)">
              <ItemSelect items={(items.data ?? []).filter((i) => i.active)} value={itemId} onChange={setItemId} placeholder="General / not listed" />
            </Field>
            <Field label="What's needed?"><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. oil for 2 days left, need 1 tin" /></Field>
            <ErrorText error={raise.error} />
            <Button variant="primary" className="w-full" disabled={note.trim().length < 2} busy={raise.isPending} onClick={() => raise.mutate()}>Raise request</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---- Waste ----

function Waste() {
  const { orgId, locationId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const items = useItems();
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [cls, setCls] = useState<'food' | 'beverage' | 'other'>('food');
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<{ name: string; qty: string; unit: string; valueMinor: number } | null>(null);
  const list = (items.data ?? []).filter((i) => i.active);
  const it = list.find((i) => i.id === itemId);
  const pick = (id: string) => {
    const x = list.find((i) => i.id === id);
    setItemId(id);
    setUnit(x?.purchase_unit ?? '');
    if (x) setCls(x.cost_class === 'food' ? 'food' : x.cost_class === 'beverage' ? 'beverage' : 'other');
  };
  const save = useMutation({
    mutationFn: () => post<{ id: string; valueMinor: number }>(`/orgs/${orgId}/waste`, { locationId, itemId, qty: qty.trim(), unit, wasteClass: cls, reason: reason.trim() }),
    onSuccess: (r) => {
      toast(`Waste recorded · ${rs(r.valueMinor)}`);
      setLast({ name: it?.name ?? '', qty, unit, valueMinor: r.valueMinor });
      setQty(''); setReason('');
      for (const k of ['stock', 'movements', 'day']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  if (items.isLoading) return <Loading />;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card title="Record waste">
        <div className="space-y-4">
          <Field label="Item"><ItemSelect items={list} value={itemId} onChange={pick} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="How much">
              <Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0"
                className={cx(qty && !validQty(qty) && 'border-[var(--bad)]')} />
            </Field>
            <Field label="Unit"><UnitSelect dim={it?.dimension} value={unit} onChange={setUnit} /></Field>
          </div>
          <Field label="Type">
            <Choice value={cls} onChange={setCls} options={[{ value: 'food', label: 'Food' }, { value: 'beverage', label: 'Drink' }, { value: 'other', label: 'Other' }]} />
          </Field>
          <Field label="What happened?"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. potatoes gone soft, oil spilled" /></Field>
          <ErrorText error={save.error} />
          <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!itemId || !validQty(qty) || !unit || reason.trim().length < 2}
            busy={save.isPending} onClick={() => save.mutate()}>Record waste</Button>
        </div>
      </Card>
      <div className="space-y-3">
        {last && (
          <Card title="Recorded">
            <p className="text-sm">{last.name} · {qtyDisplay(last.qty, last.unit)}</p>
            <p className="mt-2 text-sm text-[var(--muted)]">Value taken out of stock</p>
            <p className="text-2xl font-bold tabular text-[var(--bad)]">{rs(last.valueMinor)}</p>
          </Card>
        )}
        <p className="text-xs text-[var(--muted)]">Waste comes out of stock at its average cost and shows as a loss in the day's figures. A mix or group item is taken from its parts.</p>
      </div>
    </div>
  );
}

// ---- Weekly count ----

function WeeklyCount() {
  const { orgId, locationId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const items = useItems();
  const counts = useQuery({ queryKey: ['stock-counts', orgId, locationId], queryFn: () => get<CountRow[]>(`/orgs/${orgId}/stock-counts${qs({ locationId })}`) });
  const [vals, setVals] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [result, setResult] = useState<{ varianceMinor: number; lines: CountLine[] } | null>(null);
  const [viewing, setViewing] = useState<CountRow | null>(null);
  const sheet = (items.data ?? []).filter((i) => i.kind === 'stock' && i.active);
  const byId = useMemo(() => new Map((items.data ?? []).map((i) => [i.id, i])), [items.data]);
  const filled = sheet.filter((i) => (vals[i.id] ?? '').trim() !== '');
  const bad = filled.filter((i) => !QTY_RE.test(vals[i.id]!.trim()));

  const submit = useMutation({
    mutationFn: () => post<{ id: string; varianceMinor: number; lines: CountLine[] }>(`/orgs/${orgId}/stock-counts`, {
      locationId, note: note.trim() || undefined, lines: filled.map((i) => ({ itemId: i.id, counted: vals[i.id]!.trim(), unit: i.purchase_unit })),
    }),
    onSuccess: (r) => {
      toast('Count posted');
      setResult(r); setVals({}); setNote('');
      for (const k of ['stock-counts', 'stock', 'movements']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });

  if (items.isLoading) return <Loading />;
  return (
    <div className="space-y-4">
      {result ? (
        <Card title="Count posted" actions={<Button size="sm" onClick={() => setResult(null)}>New count</Button>}>
          <p className="mb-3 text-sm">Difference in value: <Money minor={result.varianceMinor} sign className="font-semibold" /> {result.varianceMinor < 0 ? '(shortage)' : result.varianceMinor > 0 ? '(surplus)' : ''}</p>
          <CountLinesTable lines={result.lines} byId={byId} />
        </Card>
      ) : (
        <Card title="Counting sheet" actions={<span className="text-sm text-[var(--muted)]">{filled.length} of {sheet.length} counted</span>}>
          <p className="mb-3 text-sm text-[var(--muted)]">Count what is physically there. Leave an item empty to skip it. The system's expected figure is kept forever next to your count; only the difference is adjusted.</p>
          {sheet.length === 0 ? <Empty>No stock items to count.</Empty> : (
            <div className="grid gap-4 lg:grid-cols-2">
              {groupBy(sheet, (i) => i.category).map(([cat, list]) => (
                <div key={cat}>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{cat}</h3>
                  <div className="space-y-2">
                    {list.map((i) => {
                      const v = vals[i.id] ?? '';
                      return (
                        <label key={i.id} className="grid grid-cols-[1fr_140px] items-center gap-2">
                          <span className="font-medium">{i.name}</span>
                          <span className="relative">
                            <Input inputMode="decimal" value={v} placeholder="—" onChange={(e) => setVals((x) => ({ ...x, [i.id]: e.target.value }))}
                              className={cx('pr-14 text-right tabular', v.trim() && !QTY_RE.test(v.trim()) && 'border-[var(--bad)]')} aria-label={`${i.name} counted in ${i.purchase_unit}`} />
                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted)]">{i.purchase_unit}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 space-y-3">
            <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Sunday close count" /></Field>
            <ErrorText error={submit.error} />
            {bad.length > 0 && <p className="text-sm text-[var(--bad)]">Check: {bad.map((i) => i.name).join(', ')} (numbers only, up to 3 decimals)</p>}
            <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={filled.length === 0 || bad.length > 0} busy={submit.isPending} onClick={() => submit.mutate()}>
              Post count ({filled.length} item{filled.length === 1 ? '' : 's'})
            </Button>
          </div>
        </Card>
      )}
      <Card title="Past counts">
        {counts.isLoading ? <Loading /> : (
          <Table rows={counts.data ?? []} rowKey={(r) => r.id} empty="No counts yet." onRowClick={setViewing}
            columns={[
              { label: 'Date', render: (r) => timeLabel(r.created_at) },
              { label: 'By', render: (r) => r.counted_by },
              { label: 'Items', render: (r) => (r.lines ?? []).length, hideOnMobile: true },
              { label: 'Note', render: (r) => r.note ?? '', hideOnMobile: true },
              { label: 'Difference', align: 'right', render: (r) => <Money minor={r.variance_minor} sign className="font-semibold" /> },
            ]} />
        )}
        <ErrorText error={counts.error} />
      </Card>
      {viewing && (
        <Modal open wide onClose={() => setViewing(null)} title={`Count of ${dateLabel(viewing.created_at)}`}>
          <p className="mb-3 text-sm text-[var(--muted)]">{viewing.counted_by}{viewing.note ? ` · ${viewing.note}` : ''} · difference <Money minor={viewing.variance_minor} sign /></p>
          <CountLinesTable lines={viewing.lines ?? []} byId={byId} />
        </Modal>
      )}
    </div>
  );
}

function CountLinesTable({ lines, byId }: { lines: CountLine[]; byId: Map<string, StockItem> }) {
  const unitOf = (id: string) => byId.get(id)?.purchase_unit ?? BASE_UNIT[byId.get(id)?.dimension ?? 'mass'];
  return (
    <Table rows={lines} rowKey={(r) => r.itemId}
      columns={[
        { label: 'Item', render: (r) => r.name },
        { label: 'Expected', align: 'right', render: (r) => inUnit(r.expected, unitOf(r.itemId)) },
        { label: 'Counted', align: 'right', render: (r) => inUnit(r.counted, unitOf(r.itemId)) },
        { label: 'Difference', align: 'right', render: (r) => {
          const d = Number(r.diff);
          return <span className={cx(d < 0 && 'text-[var(--bad)]', d > 0 && 'text-[var(--good)]')}>{d > 0 ? '+' : d < 0 ? '−' : ''}{inUnit(Math.abs(d), unitOf(r.itemId))}</span>;
        } },
        { label: 'Value', align: 'right', render: (r) => <Money minor={r.valueMinor} sign /> },
      ]} />
  );
}

// ---- Items & recipes ----

type Sub = 'items' | 'recipes' | 'costs';

function ItemsAndRecipes() {
  const { can } = useScope();
  const subs = ([
    { value: 'items', label: 'Items' },
    { value: 'recipes', label: 'Recipes' },
    can('reports.view') && { value: 'costs', label: 'Plate costs' },
  ].filter(Boolean) as { value: Sub; label: string }[]);
  const [sub, setSub] = useState<Sub>('items');
  return (
    <>
      <Tabs tabs={subs} value={sub} onChange={setSub} />
      {sub === 'items' && <ItemsList />}
      {sub === 'recipes' && <Recipes />}
      {sub === 'costs' && <PlateCosts />}
    </>
  );
}

const COST_CLASS: Record<string, string> = { food: 'Food', beverage: 'Drink', packaging: 'Packaging', fuel: 'Fuel' };

function ItemsList() {
  const items = useItems();
  const [editing, setEditing] = useState<StockItem | 'new' | null>(null);
  const [mixing, setMixing] = useState<StockItem | null>(null);
  const all = items.data ?? [];
  const byId = useMemo(() => new Map(all.map((i) => [i.id, i])), [all]);
  const top = all.filter((i) => !i.parent_id || !byId.has(i.parent_id));
  if (items.isLoading) return <Loading />;
  if (items.error) return <ErrorText error={items.error} />;

  const low = (i: StockItem) => (i.low_stock_base ? `Low below ${inUnit(i.low_stock_base, i.purchase_unit)}` : null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--muted)]">A <b>group</b> (e.g. Potato) holds varieties you buy; recipes can use the group and each location picks the variety in use. A <b>mix</b> is made from other items.</p>
        <Button variant="primary" onClick={() => setEditing('new')}>+ Add item</Button>
      </div>
      {top.length === 0 ? <Empty>No stock items yet.</Empty> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groupBy(top, (i) => i.category).map(([cat, list]) => (
            <Card key={cat} title={cat}>
              <div className="divide-y divide-[var(--line)]">
                {list.map((i) => {
                  const kids = all.filter((k) => k.parent_id === i.id);
                  return (
                    <div key={i.id} className="py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium">
                            {i.name} {i.kind === 'family' && <Badge tone="brand">Group</Badge>} {i.kind === 'mix' && <Badge tone="brand">Mix</Badge>} {!i.active && <Badge>Off</Badge>}
                          </div>
                          <div className="text-xs text-[var(--muted)]">
                            {[DIM_LABEL[i.dimension], `buy in ${i.purchase_unit}`, COST_CLASS[i.cost_class], i.tracking === 'bulk' ? 'bulk' : null, low(i)].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {i.kind === 'mix' && <Button size="sm" onClick={() => setMixing(i)}>Parts</Button>}
                          <Button size="sm" onClick={() => setEditing(i)}>Edit</Button>
                        </div>
                      </div>
                      {i.kind === 'mix' && (
                        <div className="mt-1 text-sm text-[var(--muted)]">
                          {i.components.length === 0 ? 'No parts set yet.' : `Per ${mixBasis(i.dimension)}: ` + i.components.map((c) => {
                            const ci = byId.get(c.itemId);
                            return `${ci ? inUnit(c.per1000Base, BASE_UNIT[ci.dimension]) : '?'} ${ci?.name ?? ''}`;
                          }).join(', ')}
                        </div>
                      )}
                      {i.kind === 'family' && (
                        <div className="mt-2 space-y-2">
                          {kids.length === 0 ? <p className="text-sm text-[var(--muted)]">No varieties yet. Add an item and pick this group as its parent.</p> : (
                            <>
                              <div className="flex flex-wrap gap-2">
                                {kids.map((k) => (
                                  <button key={k.id} onClick={() => setEditing(k)} className="h-9 rounded-lg bg-[var(--panel-2)] px-3 text-sm">
                                    {k.name}{!k.active ? ' (off)' : ''}
                                  </button>
                                ))}
                              </div>
                              <VarietyPicker family={i} varieties={kids.filter((k) => k.active)} />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && <ItemForm item={editing === 'new' ? undefined : editing} all={all} onClose={() => setEditing(null)} />}
      {mixing && <MixEditor mix={mixing} all={all} onClose={() => setMixing(null)} />}
    </div>
  );
}

const mixBasis = (d: Dim) => (d === 'mass' ? '1 kg' : d === 'volume' ? '1 L' : '1,000 units');

function VarietyPicker({ family, varieties }: { family: StockItem; varieties: StockItem[] }) {
  const { orgId, locationId, location } = useScope();
  const toast = useToast();
  const qc = useQueryClient();
  const [v, setV] = useState('');
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/varieties`, { locationId, familyId: family.id, varietyId: v }),
    onSuccess: () => {
      toast(`${location?.name ?? 'Location'} now uses ${varieties.find((x) => x.id === v)?.name ?? 'that variety'}`);
      setV('');
      void qc.invalidateQueries({ queryKey: ['plate-costs'] });
    },
    onError: (e) => toast(e.message, 'bad'),
  });
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
      <Select value={v} onChange={(e) => setV(e.target.value)} aria-label={`Variety of ${family.name} in use`}
        placeholder={`Variety in use at ${location?.name ?? 'this location'}…`} options={varieties.map((k) => ({ value: k.id, label: k.name }))} />
      <Button disabled={!v} busy={save.isPending} onClick={() => save.mutate()}>Use here</Button>
    </div>
  );
}

function ItemForm({ item, all, onClose }: { item?: StockItem; all: StockItem[]; onClose: () => void }) {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState(item?.category ?? '');
  const [kind, setKind] = useState<Kind>(item?.kind ?? 'stock');
  const [parentId, setParentId] = useState(item?.parent_id ?? '');
  const [dimension, setDimension] = useState<Dim>(item?.dimension ?? 'mass');
  const [unit, setUnit] = useState(item?.purchase_unit ?? 'kg');
  const [tracking, setTracking] = useState<'precise' | 'bulk'>(item?.tracking ?? 'precise');
  const [costClass, setCostClass] = useState<StockItem['cost_class']>(item?.cost_class ?? 'food');
  const [low, setLow] = useState(item?.low_stock_base ? toUnitStr(item.low_stock_base, item.purchase_unit) : '');
  const [active, setActive] = useState(item?.active ?? true);
  const families = all.filter((f) => f.kind === 'family' && f.id !== item?.id && f.dimension === dimension);
  const categories = [...new Set(all.map((i) => i.category))];
  const lowOk = low.trim() === '' || QTY_RE.test(low.trim());

  const changeDim = (d: Dim) => { setDimension(d); setUnit(UNITS_BY_DIM[d][0]!); setParentId(''); };
  const changeParent = (id: string) => {
    setParentId(id);
    const p = all.find((x) => x.id === id);
    if (p) { setKind('stock'); if (!category) setCategory(p.category); setCostClass(p.cost_class); }
  };
  const save = useMutation({
    mutationFn: () => post<{ id: string }>(`/orgs/${orgId}/stock-items`, {
      id: item?.id, parentId: parentId || null, name: name.trim(), category: category.trim(), kind, dimension, purchaseUnit: unit, tracking, costClass,
      lowStock: low.trim() || null, active,
    }),
    onSuccess: () => {
      toast(item ? 'Item saved' : 'Item added');
      for (const k of ['stock-items', 'stock', 'plate-costs']) void qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });
  return (
    <Modal open wide onClose={onClose} title={item ? `Edit ${item.name}` : 'Add stock item'}
      footer={<Button variant="primary" disabled={!name.trim() || !category.trim() || !lowOk} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Santos potato" /></Field>
        <Field label="Category">
          <Input value={category} onChange={(e) => setCategory(e.target.value)} list="kbay-item-categories" placeholder="e.g. Potatoes" />
          <datalist id="kbay-item-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Measured by" hint={item ? 'Cannot change once the item has stock history.' : undefined}>
          <Select value={dimension} onChange={(e) => changeDim(e.target.value as Dim)}
            options={(['mass', 'volume', 'count'] as Dim[]).map((d) => ({ value: d, label: DIM_LABEL[d] }))} />
        </Field>
        <Field label="Bought in"><UnitSelect dim={dimension} value={unit} onChange={setUnit} /></Field>
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)} disabled={!!parentId} options={[
            { value: 'stock', label: 'Stock item (bought and counted)' },
            { value: 'family', label: 'Group of varieties' },
            { value: 'mix', label: 'Mix (made from other items)' },
          ]} />
        </Field>
        <Field label="Variety of (optional)" hint="Pick a group to make this one of its varieties.">
          <Select value={parentId} onChange={(e) => changeParent(e.target.value)} placeholder="None"
            options={families.map((f) => ({ value: f.id, label: f.name }))} />
        </Field>
        <Field label="Cost type">
          <Select value={costClass} onChange={(e) => setCostClass(e.target.value as StockItem['cost_class'])}
            options={Object.entries(COST_CLASS).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Tracking">
          <Select value={tracking} onChange={(e) => setTracking(e.target.value as 'precise' | 'bulk')} options={[
            { value: 'precise', label: 'Precise (weighed per sale)' }, { value: 'bulk', label: 'Bulk (estimated, checked at count)' },
          ]} />
        </Field>
        <Field label={`Low stock alert (${unit})`} hint="Leave empty for no alert.">
          <Input inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} placeholder="—" className={cx(!lowOk && 'border-[var(--bad)]')} />
        </Field>
        {item && (
          <label className="flex h-11 items-center gap-3 self-end">
            <input type="checkbox" className="h-5 w-5 accent-brand" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span>Active</span>
          </label>
        )}
      </div>
      <div className="mt-3"><ErrorText error={save.error} /></div>
    </Modal>
  );
}

interface EditLine { key: string; itemId: string; qty: string; unit: string; stage?: Stage }
const blankLine = (stage?: Stage): EditLine => ({ key: crypto.randomUUID(), itemId: '', qty: '', unit: '', stage });

/** Rows of item + qty + unit (+ stage for recipes). */
function LineEditor({ lines, setLines, items, withStage }: { lines: EditLine[]; setLines: (f: (l: EditLine[]) => EditLine[]) => void;
  items: StockItem[]; withStage?: boolean }) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const set = (key: string, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      {lines.length === 0 && <Empty>No lines yet.</Empty>}
      {lines.map((l) => {
        const it = byId.get(l.itemId);
        return (
          <div key={l.key} className={cx('grid gap-2 rounded-xl border border-[var(--line)] p-2 sm:border-0 sm:p-0',
            withStage ? 'grid-cols-2 sm:grid-cols-[2fr_1fr_90px_110px_auto]' : 'grid-cols-2 sm:grid-cols-[2fr_1fr_90px_auto]')}>
            <div className="col-span-2 sm:col-span-1">
              <ItemSelect items={items} value={l.itemId} onChange={(id) => set(l.key, { itemId: id, unit: byId.get(id) ? BASE_UNIT[byId.get(id)!.dimension] : '' })} />
            </div>
            <Input inputMode="decimal" placeholder="Qty" aria-label="Quantity" value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })}
              className={cx(l.qty && !validQty(l.qty) && 'border-[var(--bad)]')} />
            <UnitSelect dim={it?.dimension} value={l.unit} onChange={(u) => set(l.key, { unit: u })} />
            {withStage && (
              <Select value={l.stage ?? 'serve'} onChange={(e) => set(l.key, { stage: e.target.value as Stage })} aria-label="Stage"
                options={[{ value: 'prep', label: 'Prep' }, { value: 'fry', label: 'Fry' }, { value: 'serve', label: 'Serve' }]} />
            )}
            <Button variant="ghost" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remove line">✕</Button>
          </div>
        );
      })}
    </div>
  );
}

const linesOk = (lines: EditLine[]) => lines.every((l) => l.itemId && validQty(l.qty) && l.unit) &&
  new Set(lines.map((l) => l.itemId)).size === lines.length;

function MixEditor({ mix, all, onClose }: { mix: StockItem; all: StockItem[]; onClose: () => void }) {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const byId = new Map(all.map((i) => [i.id, i]));
  const [lines, setLines] = useState<EditLine[]>(() => mix.components.map((c) => {
    const ci = byId.get(c.itemId);
    const unit = ci ? BASE_UNIT[ci.dimension] : 'g';
    return { key: crypto.randomUUID(), itemId: c.itemId, qty: toUnitStr(c.per1000Base, unit), unit };
  }));
  const save = useMutation({
    mutationFn: () => put(`/orgs/${orgId}/stock-items/${mix.id}/mix`, { components: lines.map((l) => ({ itemId: l.itemId, qty: l.qty.trim(), unit: l.unit })) }),
    onSuccess: () => {
      toast('Mix saved');
      for (const k of ['stock-items', 'plate-costs']) void qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });
  return (
    <Modal open wide onClose={onClose} title={`Parts of ${mix.name}`}
      footer={<Button variant="primary" disabled={!linesOk(lines)} busy={save.isPending} onClick={() => save.mutate()}>Save mix</Button>}>
      <p className="mb-3 text-sm text-[var(--muted)]">How much of each item goes into <b>{mixBasis(mix.dimension)}</b> of {mix.name}.</p>
      <LineEditor lines={lines} setLines={setLines} items={all.filter((i) => i.active && i.id !== mix.id)} />
      <Button size="sm" className="mt-3" onClick={() => setLines((ls) => [...ls, blankLine()])}>+ Add part</Button>
      <div className="mt-3"><ErrorText error={save.error} /></div>
    </Modal>
  );
}

// ---- Recipes ----

interface MenuVariant { id: string; name: string; size_tag: string | null; price_minor: number; open_price: boolean; enabled?: boolean; has_recipe?: boolean }
interface MenuItem { id: string; name: string; is_deal: boolean; enabled?: boolean; variants: MenuVariant[] }
interface MenuCategory { id: string; name: string; items: MenuItem[] }
interface RecipeLine { id: string; item_id: string; item_name: string; qty_base: string | number; stage: Stage; dimension: Dim }

function Recipes() {
  const { orgId, locationId, can } = useScope();
  const all = can('menu.manage');
  const menu = useQuery({ queryKey: ['menu', orgId, all ? 'all' : locationId],
    queryFn: () => get<MenuCategory[]>(`/orgs/${orgId}/menu${qs(all ? { all: true } : { locationId })}`) });
  const items = useItems();
  const [variantId, setVariantId] = useState('');
  const flat = useMemo(() => (menu.data ?? []).flatMap((c) => c.items.flatMap((i) => i.variants.map((v) => ({ item: i, v })))), [menu.data]);
  const chosen = flat.find((x) => x.v.id === variantId);

  if (menu.isLoading || items.isLoading) return <Loading />;
  return (
    <div className="space-y-4">
      <ErrorText error={menu.error} />
      <Card>
        <Field label="Menu item and size">
          <select className={selectCls} value={variantId} onChange={(e) => setVariantId(e.target.value)}>
            <option value="">Pick a size</option>
            {(menu.data ?? []).map((c) => (
              <optgroup key={c.id} label={c.name}>
                {c.items.flatMap((i) => i.variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {i.name} — {v.name}{v.open_price ? '' : ` (${rs(v.price_minor)})`}{v.has_recipe === false ? ' · no recipe' : ''}
                  </option>
                )))}
              </optgroup>
            ))}
          </select>
        </Field>
        <p className="mt-2 text-xs text-[var(--muted)]">Recipe amounts are estimates until the calibration study; plate costs and food used follow them.</p>
      </Card>
      {chosen && (chosen.item.is_deal
        ? <Empty>{chosen.item.name} is a deal: it uses the recipes of the items inside it. You can still add extras below if the deal adds something.</Empty>
        : null)}
      {chosen && <RecipeEditor key={chosen.v.id} variantId={chosen.v.id} title={`${chosen.item.name} — ${chosen.v.name}`} items={(items.data ?? []).filter((i) => i.active)} />}
    </div>
  );
}

function RecipeEditor({ variantId, title, items }: { variantId: string; title: string; items: StockItem[] }) {
  const { orgId } = useScope();
  const recipe = useQuery({ queryKey: ['recipe', orgId, variantId], queryFn: () => get<RecipeLine[]>(`/orgs/${orgId}/recipes/${variantId}`) });
  if (recipe.isLoading) return <Loading />;
  if (recipe.error) return <ErrorText error={recipe.error} />;
  return <RecipeLines variantId={variantId} title={title} items={items} initial={recipe.data ?? []} />;
}

function RecipeLines({ variantId, title, items, initial }: { variantId: string; title: string; items: StockItem[]; initial: RecipeLine[] }) {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const [lines, setLines] = useState<EditLine[]>(() => initial.map((r) => ({
    key: r.id, itemId: r.item_id, qty: toUnitStr(r.qty_base, BASE_UNIT[r.dimension]), unit: BASE_UNIT[r.dimension], stage: r.stage,
  })));
  const [dirty, setDirty] = useState(false);
  const update = (f: (l: EditLine[]) => EditLine[]) => { setLines(f); setDirty(true); };
  const save = useMutation({
    mutationFn: () => put(`/orgs/${orgId}/recipes/${variantId}`, { lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty.trim(), unit: l.unit, stage: l.stage ?? 'serve' })) }),
    onSuccess: () => {
      toast('Recipe saved');
      setDirty(false);
      for (const k of ['recipe', 'plate-costs', 'menu']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const dupes = new Set(lines.map((l) => l.itemId)).size !== lines.length;
  return (
    <Card title={title} actions={<Button size="sm" onClick={() => update((ls) => [...ls, blankLine('serve')])}>+ Add ingredient</Button>}>
      <p className="mb-3 text-sm text-[var(--muted)]">What one plate of this size uses. Prep = before frying, Fry = in the fryer (oil, potato), Serve = toppings and packing.</p>
      <LineEditor lines={lines} setLines={update} items={items} withStage />
      {dupes && <p className="mt-2 text-sm text-[var(--bad)]">Each ingredient can appear only once.</p>}
      <div className="mt-4 space-y-3">
        <ErrorText error={save.error} />
        <Button variant="primary" disabled={!dirty || !linesOk(lines)} busy={save.isPending} onClick={() => save.mutate()}>Save recipe</Button>
      </div>
    </Card>
  );
}

// ---- Plate costs ----

interface PlateCost {
  id: string; item_name: string; variant_name: string; price_minor: number; open_price: boolean; recipe_basis_minor: number | null; enabled: boolean;
  cost_minor: number | null; margin_minor: number | null; has_recipe: boolean;
}

function PlateCosts() {
  const { orgId, locationId, location } = useScope();
  const costs = useQuery({ queryKey: ['plate-costs', orgId, locationId], queryFn: () => get<PlateCost[]>(`/orgs/${orgId}/plate-costs${qs({ locationId })}`) });
  const pct = (r: PlateCost): ReactNode => {
    const price = r.open_price ? r.recipe_basis_minor ?? 0 : r.price_minor;
    if (r.margin_minor === null || price <= 0) return '—';
    const p = Math.round((r.margin_minor / price) * 100);
    return <span className={cx('tabular', p < 0 && 'text-[var(--bad)]')}>{p}%</span>;
  };
  return (
    <Card title={`Plate costs at ${location?.name ?? 'this location'}`}>
      <p className="mb-3 text-sm text-[var(--muted)]">Theoretical cost from each recipe at today's average stock cost. Recipe amounts are estimates until the calibration study.</p>
      {costs.isLoading ? <Loading /> : (
        <Table rows={costs.data ?? []} rowKey={(r) => r.id} empty="No menu items yet."
          columns={[
            { label: 'Item', render: (r) => <span className="font-medium">{r.item_name} {!r.enabled && <Badge>Off</Badge>}</span> },
            { label: 'Size', render: (r) => r.variant_name },
            { label: 'Price', align: 'right', render: (r) => (r.open_price ? <span>{rs(r.recipe_basis_minor)} <span className="text-xs text-[var(--muted)]">(basis)</span></span> : <Money minor={r.price_minor} />) },
            { label: 'Cost', align: 'right', render: (r) => (r.has_recipe ? <Money minor={r.cost_minor} /> : <Badge tone="warn">No recipe</Badge>) },
            { label: 'Margin', align: 'right', render: (r) => (r.margin_minor === null ? '—' : <Money minor={r.margin_minor} className="font-semibold" />) },
            { label: 'Margin %', align: 'right', render: pct },
          ]} />
      )}
      <ErrorText error={costs.error} />
    </Card>
  );
}
