import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { get, qs } from '../api';
import { BarList, ColumnChart, TrendChart, VIZ } from '../components/charts';
import { Badge, Button, Card, cx, Empty, ErrorText, Input, Loading, Money, Select, Stat, Table, Tabs } from '../components/ui';
import { dateLabel, daysAgo, monthStart, rs, timeLabel, todayPk } from '../format';
import { useScope } from '../session';

// ---- Response shapes (reporting/service.ts). Money is integer paisa. ----
interface Dashboard {
  sales: number; refunds: number; revenue: number; cogs: number; expenses: number; profit: number; grossProfit: number; orders: number; plates: number;
  series: { d: string; sales: number; profit: number }[];
}
interface Expenses { heads: { code: string; name: string; amount_minor: number }[]; purchases: { category: string; amount_minor: number }[] }
interface StallRow { location_id: string; name: string; kind: string; sales_minor: number; profit_minor: number; days: number }
interface PlateRow {
  item_name: string; variant_name: string; variant_id: string; category_name: string; qty: number; revenue_minor: number; cost_minor: number;
  profit_minor: number; profit_per_plate_minor: number | null;
}
interface HourRow { hour: number; revenue_minor: number; qty: number }
interface LabourRow { person_id: string; name: string; wages_minor: number; commission_minor: number }
interface VoidRow { kind: string; entry_date: string; memo: string | null; by_name: string | null; amount_minor: number; location_name: string | null }
interface PnlRow { code: string; name: string; type: 'revenue' | 'expense'; amount_minor: number }
interface TbRow { code: string; name: string; type: string; debit_minor: number; credit_minor: number }
interface JournalRow {
  id: string; entry_date: string; memo: string | null; source_type: string; source_id: string | null; reverses_entry_id: string | null; created_at: string;
  location_name: string | null; created_by_name: string | null; lines: { code: string; account: string; debitMinor: number; creditMinor: number }[] | null;
}

type Preset = 'today' | '7d' | 'month' | '30d' | 'custom';
type Section = 'overview' | 'expenses' | 'stalls' | 'plates' | 'hours' | 'labour' | 'voids' | 'accounts';
interface Filter { from: string; to: string; locationId: string }

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: 'month', label: 'This month' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom' },
];

function presetRange(p: Preset): { from: string; to: string } | null {
  const t = todayPk();
  if (p === 'today') return { from: t, to: t };
  if (p === '7d') return { from: daysAgo(6), to: t };
  if (p === 'month') return { from: monthStart(), to: t };
  if (p === '30d') return { from: daysAgo(29), to: t };
  return null;
}

/** One report query: keeps the previous numbers on screen (dimmed) while a new range loads. */
function useReport<T>(name: string, f: Filter, opts: { withLocation?: boolean; enabled?: boolean } = {}) {
  const { orgId } = useScope();
  const loc = opts.withLocation === false ? undefined : f.locationId || undefined;
  return useQuery({
    queryKey: ['report', name, orgId, f.from, f.to, loc ?? 'all'],
    queryFn: () => get<T>(`/orgs/${orgId}/reports/${name}${qs({ from: f.from, to: f.to, locationId: loc })}`),
    placeholderData: keepPreviousData,
    enabled: opts.enabled !== false,
  });
}

export function Reports() {
  const { org, can } = useScope();
  const [preset, setPreset] = useState<Preset>('month');
  const [custom, setCustom] = useState({ from: monthStart(), to: todayPk() });
  const [locationId, setLocationId] = useState('');
  const [section, setSection] = useState<Section>('overview');

  if (!can('reports.view')) return <Empty>You do not have access to reports.</Empty>;

  const range = presetRange(preset) ?? custom;
  const badRange = range.from > range.to;
  const f: Filter = { ...range, locationId };
  const locName = locationId ? org.locations.find((l) => l.id === locationId)?.name ?? 'One location' : 'All locations';
  const rangeText = range.from === range.to ? dateLabel(range.from) : `${dateLabel(range.from)} – ${dateLabel(range.to)}`;

  const tabs: { value: Section; label: string }[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'expenses', label: 'Expenses' },
    { value: 'stalls', label: 'Stalls' },
    { value: 'plates', label: 'Plate sizes' },
    { value: 'hours', label: 'Busy hours' },
    { value: 'labour', label: 'Labour' },
    { value: 'voids', label: 'Voids & refunds' },
    ...(can('finance.view') ? [{ value: 'accounts' as const, label: 'Accounts' }] : []),
  ];

  return (
    <div className="kbay-print-area">
      {/* Branded report header: on screen and on paper. */}
      <div className="mb-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)]">
        <div className="h-1.5 bg-brand" />
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            <img src="/icons/icon.svg" alt="" className="h-10 w-10" />
            <div>
              <div className="text-xl font-black tracking-tight">{org.brand_name || 'K-BAY'} <span className="font-semibold text-[var(--muted)]">Reports</span></div>
              <div className="text-sm text-[var(--muted)]">{rangeText} · {locName}</div>
            </div>
          </div>
          <Button size="sm" onClick={() => window.print()} className="print:hidden">Print</Button>
        </div>
      </div>

      {/* Filters: one row, above everything they scope. */}
      <div className="mb-4 space-y-3 print:hidden">
        <div className="flex flex-wrap gap-2">
          <div role="group" aria-label="Date range" className="flex flex-wrap gap-1 rounded-xl bg-[var(--panel-2)] p-1">
            {PRESETS.map((p) => (
              <button key={p.value} onClick={() => setPreset(p.value)} aria-pressed={preset === p.value}
                className={cx('h-9 rounded-lg px-3 text-sm font-medium', preset === p.value ? 'bg-[var(--panel)] shadow-sm' : 'text-[var(--muted)]')}>
                {p.label}
              </button>
            ))}
          </div>
          <Select aria-label="Location" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-11 w-auto min-w-44"
            options={[{ value: '', label: 'All locations' }, ...org.locations.map((l) => ({ value: l.id, label: l.name }))]} />
        </div>
        {preset === 'custom' && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">From</span>
              <Input type="date" value={custom.from} max={todayPk()} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} className="w-44" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">To</span>
              <Input type="date" value={custom.to} max={todayPk()} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} className="w-44" />
            </label>
          </div>
        )}
      </div>

      <div className="print:hidden">
        <Tabs tabs={tabs} value={section} onChange={setSection} />
      </div>
      <h2 className="mb-3 hidden text-lg font-bold print:block">{tabs.find((t) => t.value === section)?.label}</h2>

      {badRange ? <ErrorText error="The start date is after the end date." /> : (
        <>
          {section === 'overview' && <Overview f={f} />}
          {section === 'expenses' && <ExpensesSection f={f} />}
          {section === 'stalls' && <Stalls f={f} />}
          {section === 'plates' && <Plates f={f} />}
          {section === 'hours' && <Hours f={f} />}
          {section === 'labour' && <Labour f={f} />}
          {section === 'voids' && <Voids f={f} />}
          {section === 'accounts' && can('finance.view') && <Accounts f={f} />}
        </>
      )}
      <p className="mt-6 hidden text-xs text-[var(--muted)] print:block">Printed {timeLabel(new Date())} · Figures from the K-BAY books (double-entry ledger).</p>
    </div>
  );
}

/** Shows a query's state; keeps old numbers visible (dimmed) while refetching. */
function Q<T>({ q, children }: { q: { data: T | undefined; isLoading: boolean; error: unknown; isPlaceholderData: boolean; isFetching: boolean };
  children: (d: T) => ReactNode }) {
  if (q.isLoading) return <Loading />;
  if (q.error && !q.data) return <ErrorText error={q.error} />;
  if (!q.data) return null;
  return <div className={cx('transition-opacity', q.isPlaceholderData && q.isFetching && 'opacity-60')}>{children(q.data)}</div>;
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}% of sales` : undefined);

// ---------------------------------------------------------------- 1. Overview

function Overview({ f }: { f: Filter }) {
  const q = useReport<Dashboard>('dashboard', f);
  return (
    <Q q={q}>{(d) => {
      const allCosts = d.expenses;
      const trading = d.series.filter((s) => s.sales !== 0);
      const k = Math.min(7, Math.floor(trading.length / 2));
      const avg = (xs: typeof trading) => (xs.length ? Math.round(xs.reduce((a, s) => a + s.sales, 0) / xs.length) : 0);
      const early = k > 0 ? avg(trading.slice(0, k)) : 0;
      const late = k > 0 ? avg(trading.slice(-k)) : 0;
      const growth = early > 0 ? Math.round(((late - early) / early) * 100) : null;
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Sales" value={rs(d.sales)} sub={`${d.orders.toLocaleString('en-PK')} orders`} />
            <Stat label="Refunds" value={rs(d.refunds)} sub={pct(d.refunds, d.sales)} />
            <Stat label="Cost of food" value={rs(d.cogs)} sub={pct(d.cogs, d.sales) ?? 'From recipes and stock'} />
            <Stat label="All costs" value={rs(allCosts)} sub={pct(allCosts, d.sales) ?? 'Food, wages, gas, rent…'} />
            <Stat label="Profit" value={rs(d.profit)} tone={d.profit >= 0 ? 'good' : 'bad'} sub={pct(d.profit, d.sales)} />
            <Stat label="Gross profit" value={rs(d.grossProfit)} sub="Sales after food cost" />
            <Stat label="Orders" value={d.orders.toLocaleString('en-PK')} sub={d.orders > 0 ? `Avg ${rs(Math.round(d.sales / d.orders))} per order` : undefined} />
            <Stat label="Plates" value={d.plates.toLocaleString('en-PK')} sub={trading.length > 0 ? `${trading.length} trading days` : undefined} />
          </div>
          <Card title="Growth — daily sales and profit">
            {k > 0 && growth !== null && (
              <p className="mb-3 text-sm">
                An average day went from <b>{rs(early)}</b> (first {k} trading days) to <b>{rs(late)}</b> (last {k}) —{' '}
                <span className={cx('font-semibold', growth >= 0 ? 'text-[var(--good)]' : 'text-[var(--bad)]')}>
                  {growth >= 0 ? '▲' : '▼'} {Math.abs(growth)}%
                </span>.
              </p>
            )}
            {d.series.length === 0 ? <Empty>No sales in this period.</Empty> : (
              <TrendChart title="Daily sales and profit" series={[{ name: 'Sales', color: VIZ.s1 }, { name: 'Profit', color: VIZ.s2 }]}
                data={d.series.map((s) => ({ date: s.d, values: [s.sales, s.profit] }))} />
            )}
          </Card>
        </div>
      );
    }}</Q>
  );
}

// ---------------------------------------------------------------- 2. Expenses

function ExpensesSection({ f }: { f: Filter }) {
  const q = useReport<Expenses>('expenses', f);
  return (
    <Q q={q}>{(d) => {
      const total = d.heads.reduce((a, h) => a + h.amount_minor, 0);
      const bought = d.purchases.reduce((a, p) => a + p.amount_minor, 0);
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Where the money goes" actions={<span className="text-sm text-[var(--muted)]">Total <b className="text-[var(--ink)]"><Money minor={total} /></b></span>}>
            {d.heads.length === 0 ? <Empty>No costs in this period.</Empty> : (
              <BarList title="Costs by expense head" series={[{ name: 'Amount', color: VIZ.s1 }]}
                rows={d.heads.map((h) => ({ key: h.code, label: `${h.name}${total > 0 ? ` · ${Math.round((h.amount_minor / total) * 100)}%` : ''}`, values: [h.amount_minor] }))} />
            )}
          </Card>
          <Card title="What was bought, by stock type" actions={<span className="text-sm text-[var(--muted)]">Total <b className="text-[var(--ink)]"><Money minor={bought} /></b></span>}>
            <p className="mb-3 text-xs text-[var(--muted)]">Purchases posted in the period (cash view). Food cost on the left counts what was used, not bought.</p>
            <Table rows={d.purchases} rowKey={(r) => r.category} empty="No purchases in this period."
              columns={[
                { label: 'Stock type', render: (r) => <span className="capitalize">{r.category}</span> },
                { label: 'Bought', align: 'right', render: (r) => <Money minor={r.amount_minor} /> },
                { label: 'Share', align: 'right', render: (r) => (bought > 0 ? `${Math.round((r.amount_minor / bought) * 100)}%` : '—') },
              ]} />
          </Card>
        </div>
      );
    }}</Q>
  );
}

// ---------------------------------------------------------------- 3. Stalls

function Stalls({ f }: { f: Filter }) {
  const q = useReport<StallRow[]>('stalls', f, { withLocation: false });
  return (
    <Q q={q}>{(rows) => {
      const best = rows.reduce<StallRow | null>((b, r) => (r.days > 0 && (!b || r.profit_minor > b.profit_minor) ? r : b), null);
      return (
        <div className="space-y-4">
          <Card title="Which stall performs best">
            {f.locationId && <p className="mb-3 text-xs text-[var(--muted)]">Showing every stall so they can be compared.</p>}
            {rows.length === 0 ? <Empty>No stalls yet.</Empty> : (
              <BarList title="Sales and profit per stall" series={[{ name: 'Sales', color: VIZ.s1 }, { name: 'Profit', color: VIZ.s2 }]}
                rows={rows.map((r) => ({ key: r.location_id, label: r.name, values: [r.sales_minor, r.profit_minor] }))} />
            )}
          </Card>
          <Card>
            <Table rows={rows} rowKey={(r) => r.location_id}
              columns={[
                { label: 'Stall', render: (r) => <span className="font-medium">{r.name} {best?.location_id === r.location_id && <Badge tone="brand">Top profit</Badge>}</span> },
                { label: 'Days open', align: 'right', render: (r) => r.days },
                { label: 'Sales', align: 'right', render: (r) => <Money minor={r.sales_minor} /> },
                { label: 'Profit', align: 'right', render: (r) => <Money minor={r.profit_minor} /> },
                { label: 'Profit / day', align: 'right', render: (r) => (r.days > 0 ? <Money minor={Math.round(r.profit_minor / r.days)} /> : '—') },
                { label: 'Margin', align: 'right', render: (r) => (r.sales_minor > 0 ? `${Math.round((r.profit_minor / r.sales_minor) * 100)}%` : '—') },
              ]} />
          </Card>
        </div>
      );
    }}</Q>
  );
}

// ---------------------------------------------------------------- 4. Plate sizes

function Plates({ f }: { f: Filter }) {
  const q = useReport<PlateRow[]>('plates', f);
  return (
    <Q q={q}>{(raw) => {
      const rows = [...raw].sort((a, b) => b.profit_minor - a.profit_minor);
      const top = rows[0];
      const bestPer = rows.reduce<PlateRow | null>((b, r) => (r.qty > 0 && (!b || (r.profit_per_plate_minor ?? 0) > (b.profit_per_plate_minor ?? 0)) ? r : b), null);
      const label = (r: PlateRow) => `${r.item_name}${r.variant_name ? ` · ${r.variant_name}` : ''}`;
      return (
        <Card title="Which plate size really makes money">
          {top && top.profit_minor > 0 && (
            <div className="mb-4 rounded-xl bg-brand/15 p-3 text-sm">
              Most profit: <b>{label(top)}</b> — <Money minor={top.profit_minor} /> from {top.qty.toLocaleString('en-PK')} plates.
              {bestPer && bestPer.variant_id !== top.variant_id && (
                <> Best per plate: <b>{label(bestPer)}</b> at <Money minor={bestPer.profit_per_plate_minor} />.</>
              )}
            </div>
          )}
          <p className="mb-3 text-xs text-[var(--muted)]">Cost is the actual ingredients drawn from stock for these sales.</p>
          <Table rows={rows} rowKey={(r) => `${r.variant_id}-${r.item_name}`} empty="No sales in this period."
            columns={[
              { label: 'Item / size', render: (r) => (
                <span className={cx(r === top && 'font-semibold')}>
                  {label(r)} {r === top && r.profit_minor > 0 && <Badge tone="brand">Most profit</Badge>}
                  {bestPer && r === bestPer && r !== top && <Badge tone="good">Best per plate</Badge>}
                </span>
              ) },
              { label: 'Sold', align: 'right', render: (r) => r.qty.toLocaleString('en-PK') },
              { label: 'Revenue', align: 'right', render: (r) => <Money minor={r.revenue_minor} /> },
              { label: 'Ingredient cost', align: 'right', render: (r) => <Money minor={r.cost_minor} /> },
              { label: 'Profit', align: 'right', render: (r) => <Money minor={r.profit_minor} className="font-semibold" /> },
              { label: 'Per plate', align: 'right', render: (r) => <Money minor={r.profit_per_plate_minor} /> },
            ]} />
        </Card>
      );
    }}</Q>
  );
}

// ---------------------------------------------------------------- 5. Busy hours

const hourLabel = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);

function Hours({ f }: { f: Filter }) {
  const q = useReport<HourRow[]>('hours', f);
  return (
    <Q q={q}>{(raw) => {
      if (raw.length === 0) return <Card title="When customers buy"><Empty>No sales in this period.</Empty></Card>;
      const lo = Math.min(...raw.map((r) => r.hour));
      const hi = Math.max(...raw.map((r) => r.hour));
      const rows = Array.from({ length: hi - lo + 1 }, (_, i) => {
        const h = lo + i;
        const r = raw.find((x) => x.hour === h);
        return { key: String(h), label: hourLabel(h), value: r?.revenue_minor ?? 0, extra: `${(r?.qty ?? 0).toLocaleString('en-PK')} plates` };
      });
      const peak = raw.reduce((b, r) => (r.revenue_minor > b.revenue_minor ? r : b), raw[0]!);
      const total = raw.reduce((a, r) => a + r.revenue_minor, 0);
      return (
        <Card title="When customers buy">
          <p className="mb-3 text-sm">
            Busiest hour: <b>{hourLabel(peak.hour)}–{hourLabel((peak.hour + 1) % 24)}</b>, with <Money minor={peak.revenue_minor} />
            {total > 0 ? ` (${Math.round((peak.revenue_minor / total) * 100)}% of sales)` : ''}. Staff and prep for it.
          </p>
          <ColumnChart title="Sales by hour of day" rows={rows} valueLabel="Sales" extra="Plates" />
        </Card>
      );
    }}</Q>
  );
}

// ---------------------------------------------------------------- 6. Labour

function Labour({ f }: { f: Filter }) {
  const q = useReport<LabourRow[]>('labour', f);
  return (
    <Q q={q}>{(rows) => {
      const wages = rows.reduce((a, r) => a + r.wages_minor, 0);
      const comm = rows.reduce((a, r) => a + r.commission_minor, 0);
      return (
        <Card title="What each person was paid">
          {f.locationId && <p className="mb-3 text-xs text-[var(--muted)]">Wages are kept for the whole business, so this list covers every location.</p>}
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Stat label="Wages" value={rs(wages)} />
            <Stat label="Commission" value={rs(comm)} />
            <Stat label="Total" value={rs(wages + comm)} />
          </div>
          <Table rows={rows} rowKey={(r) => r.person_id} empty="No wages or commission paid in this period."
            columns={[
              { label: 'Person', render: (r) => <span className="font-medium">{r.name}</span> },
              { label: 'Wages', align: 'right', render: (r) => <Money minor={r.wages_minor} /> },
              { label: 'Commission', align: 'right', render: (r) => <Money minor={r.commission_minor} /> },
              { label: 'Total', align: 'right', render: (r) => <Money minor={r.wages_minor + r.commission_minor} className="font-semibold" /> },
            ]} />
        </Card>
      );
    }}</Q>
  );
}

// ---------------------------------------------------------------- 7. Voids & refunds

function Voids({ f }: { f: Filter }) {
  const q = useReport<VoidRow[]>('voids', f);
  return (
    <Q q={q}>{(rows) => {
      const byPerson = new Map<string, { n: number; amount: number }>();
      for (const r of rows) {
        const k = r.by_name ?? 'Unknown';
        const p = byPerson.get(k) ?? { n: 0, amount: 0 };
        byPerson.set(k, { n: p.n + 1, amount: p.amount + r.amount_minor });
      }
      const people = [...byPerson.entries()].sort((a, b) => b[1].amount - a[1].amount);
      const keyed = rows.map((r, i) => ({ ...r, key: String(i) }));
      return (
        <Card title="Voids and refunds">
          <p className="mb-3 rounded-xl bg-amber-500/15 px-3 py-2 text-sm">This is where theft hides: check who voids or refunds often, and why.</p>
          {people.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {people.map(([name, p]) => (
                <span key={name} className="rounded-xl border border-[var(--line)] px-3 py-1.5 text-sm">
                  <b>{name}</b> · {p.n} {p.n === 1 ? 'entry' : 'entries'} · <Money minor={p.amount} />
                </span>
              ))}
            </div>
          )}
          <Table rows={keyed} rowKey={(r) => r.key} empty="No voids or refunds in this period. Good."
            columns={[
              { label: 'Date', render: (r) => dateLabel(r.entry_date) },
              { label: 'Type', render: (r) => <Badge tone={r.kind === 'refund' ? 'warn' : 'bad'}>{r.kind === 'order_void' ? 'Void' : 'Refund'}</Badge> },
              { label: 'By', render: (r) => r.by_name ?? '—' },
              { label: 'Location', render: (r) => r.location_name ?? '—', hideOnMobile: true },
              { label: 'Reason / note', render: (r) => <span className="text-[var(--muted)]">{r.memo ?? '—'}</span> },
              { label: 'Amount', align: 'right', render: (r) => <Money minor={r.amount_minor} /> },
            ]} />
        </Card>
      );
    }}</Q>
  );
}

// ---------------------------------------------------------------- 8. Accounts

function Accounts({ f }: { f: Filter }) {
  const { orgId } = useScope();
  const pnl = useReport<PnlRow[]>('pnl', f);
  const tb = useQuery({
    queryKey: ['report', 'trial-balance', orgId, f.to],
    queryFn: () => get<TbRow[]>(`/orgs/${orgId}/reports/trial-balance${qs({ asOf: f.to })}`),
    placeholderData: keepPreviousData,
  });
  const jr = useQuery({
    queryKey: ['report', 'journal', orgId, f.from, f.to],
    queryFn: () => get<JournalRow[]>(`/orgs/${orgId}/reports/journal${qs({ from: f.from, to: f.to })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-4">
      <Card title="Profit and loss">
        <Q q={pnl}>{(rows) => <PnlTable rows={rows} />}</Q>
      </Card>
      <Card title={`Trial balance as of ${dateLabel(f.to)}`}>
        {f.locationId && <p className="mb-3 text-xs text-[var(--muted)]">The trial balance always covers the whole business.</p>}
        <Q q={tb}>{(rows) => <TrialBalance rows={rows} />}</Q>
      </Card>
      <Card title="Journal">
        <p className="mb-3 text-xs text-[var(--muted)]">Every entry in the books for the period (whole business, newest first, up to 500). Tap one to see its lines.</p>
        <Q q={jr}>{(rows) => <Journal rows={rows} />}</Q>
      </Card>
    </div>
  );
}

function PnlTable({ rows }: { rows: PnlRow[] }) {
  const revenue = rows.filter((r) => r.type === 'revenue');
  const expense = rows.filter((r) => r.type === 'expense');
  const totalRev = revenue.reduce((a, r) => a + r.amount_minor, 0);
  const totalExp = expense.reduce((a, r) => a - r.amount_minor, 0);
  if (rows.length === 0) return <Empty>No income or costs in this period.</Empty>;
  const Line = ({ r, neg }: { r: PnlRow; neg?: boolean }) => (
    <tr className="border-b border-[var(--line)]">
      <td className="py-1.5 pr-2 text-[var(--muted)] tabular">{r.code}</td>
      <td className="py-1.5 pr-2">{r.name}</td>
      <td className="py-1.5 text-right"><Money minor={neg ? -r.amount_minor : r.amount_minor} /></td>
    </tr>
  );
  return (
    <table className="w-full text-sm">
      <tbody>
        <tr><td colSpan={3} className="pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Income</td></tr>
        {revenue.map((r) => <Line key={r.code} r={r} />)}
        <tr className="font-semibold"><td /><td className="py-2">Total income</td><td className="py-2 text-right"><Money minor={totalRev} /></td></tr>
        <tr><td colSpan={3} className="pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Costs</td></tr>
        {expense.map((r) => <Line key={r.code} r={r} neg />)}
        <tr className="font-semibold"><td /><td className="py-2">Total costs</td><td className="py-2 text-right"><Money minor={totalExp} /></td></tr>
        <tr className="border-t-2 border-[var(--ink)] text-base font-bold">
          <td /><td className="py-2">{totalRev - totalExp >= 0 ? 'Profit' : 'Loss'}</td>
          <td className={cx('py-2 text-right', totalRev - totalExp >= 0 ? 'text-[var(--good)]' : 'text-[var(--bad)]')}><Money minor={totalRev - totalExp} /></td>
        </tr>
      </tbody>
    </table>
  );
}

function TrialBalance({ rows }: { rows: TbRow[] }) {
  // Net each account to the side it sits on; the two columns must agree.
  const net = rows.map((r) => ({ ...r, dr: Math.max(0, r.debit_minor - r.credit_minor), cr: Math.max(0, r.credit_minor - r.debit_minor) }));
  const dr = net.reduce((a, r) => a + r.dr, 0);
  const cr = net.reduce((a, r) => a + r.cr, 0);
  const balanced = dr === cr;
  if (rows.length === 0) return <Empty>No entries yet.</Empty>;
  return (
    <>
      <div className={cx('mb-3 rounded-xl px-3 py-2 text-sm', balanced ? 'bg-green-600/10' : 'bg-red-600/10')}>
        {balanced
          ? <>✓ The books balance: total debits <b><Money minor={dr} /></b> = total credits <b><Money minor={cr} /></b>.</>
          : <span className="text-[var(--bad)]">✗ Out of balance: debits <Money minor={dr} />, credits <Money minor={cr} /> (difference {rs(dr - cr)}).</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="py-2 pr-2 font-medium">Code</th><th className="py-2 pr-2 font-medium">Account</th>
              <th className="py-2 pr-2 font-medium">Type</th>
              <th className="py-2 pr-2 text-right font-medium">Debit</th><th className="py-2 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody>
            {net.map((r) => (
              <tr key={r.code} className="border-b border-[var(--line)]">
                <td className="py-1.5 pr-2 tabular text-[var(--muted)]">{r.code}</td>
                <td className="py-1.5 pr-2">{r.name}</td>
                <td className="py-1.5 pr-2 capitalize text-[var(--muted)]">{r.type}</td>
                <td className="py-1.5 pr-2 text-right">{r.dr ? <Money minor={r.dr} /> : ''}</td>
                <td className="py-1.5 text-right">{r.cr ? <Money minor={r.cr} /> : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--ink)] font-bold">
              <td /><td className="py-2">Total</td><td />
              <td className="py-2 pr-2 text-right"><Money minor={dr} /></td><td className="py-2 text-right"><Money minor={cr} /></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  order: 'Sale', order_void: 'Void', refund: 'Refund', expense: 'Expense', purchase: 'Purchase', transfer: 'Transfer', day_open: 'Day open',
  day_close: 'Day close', capital: 'Capital', wage: 'Wages', supplier_payment: 'Supplier payment', stock: 'Stock', waste: 'Waste',
};

function Journal({ rows }: { rows: JournalRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return <Empty>No entries in this period.</Empty>;
  return (
    <ul className="divide-y divide-[var(--line)]">
      {rows.map((e) => {
        const lines = e.lines ?? [];
        const amount = lines.reduce((a, l) => a + l.debitMinor, 0);
        const isOpen = open === e.id;
        return (
          <li key={e.id} className="py-1">
            <button onClick={() => setOpen(isOpen ? null : e.id)} aria-expanded={isOpen}
              className="flex w-full items-start gap-3 rounded-lg px-1 py-2 text-left hover:bg-[var(--panel-2)]">
              <span className="mt-0.5 w-4 shrink-0 text-[var(--muted)] print:hidden" aria-hidden>{isOpen ? '▾' : '▸'}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{e.memo ?? SOURCE_LABEL[e.source_type] ?? e.source_type}</span>
                <span className="block text-xs text-[var(--muted)]">
                  {dateLabel(e.entry_date)} · {SOURCE_LABEL[e.source_type] ?? e.source_type.replace(/_/g, ' ')}
                  {e.location_name ? ` · ${e.location_name}` : ''}{e.created_by_name ? ` · ${e.created_by_name}` : ''}
                  {e.reverses_entry_id ? ' · reversal' : ''}
                </span>
              </span>
              <Money minor={amount} className="shrink-0 text-sm font-semibold" />
            </button>
            {isOpen && (
              <div className="mb-2 ml-6 overflow-x-auto rounded-lg bg-[var(--panel-2)] p-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-[var(--muted)]">
                      <th className="px-2 py-1 font-medium">Account</th><th className="px-2 py-1 text-right font-medium">Debit</th><th className="px-2 py-1 text-right font-medium">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1"><span className="tabular text-[var(--muted)]">{l.code}</span> {l.account}</td>
                        <td className="px-2 py-1 text-right">{l.debitMinor ? <Money minor={l.debitMinor} /> : ''}</td>
                        <td className="px-2 py-1 text-right">{l.creditMinor ? <Money minor={l.creditMinor} /> : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-2 pt-1 text-xs text-[var(--muted)]">Recorded {timeLabel(e.created_at)}</p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
