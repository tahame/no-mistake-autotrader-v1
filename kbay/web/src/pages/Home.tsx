import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get, qs } from '../api';
import { Sparkline } from '../components/charts';
import { Badge, Card, cx, ErrorText, Spinner, Stat } from '../components/ui';
import { dateLabel, monthStart, qtyDisplay, rs, todayPk } from '../format';
import { useScope } from '../session';

interface DayFigures { sales: number; refunds: number; cogs: number; waste: number; other_expenses: number; profit: number }
interface Current {
  day: { id: string; business_date: string; opened_at: string } | null;
  figures: DayFigures | null;
  awaitingApproval: { id: string; business_date: string } | null;
}
interface ApprovalRow { id: string; kind: string; summary: string; canDecide: boolean }
interface StockRow { id: string; name: string; category: string; qty_display: string; purchase_unit: string; is_low: boolean }
interface Dashboard { sales: number; profit: number; orders: number; plates: number; series: { d: string; sales: number; profit: number }[] }

const APPROVE_PERMS = ['approve.expense', 'approve.purchase', 'approve.supplier_credit', 'approve.day_close', 'approve.withdrawal',
  'approve.refund', 'approve.loan_refund', 'approve.partner_change'];

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function Home() {
  const { me, org, location, can } = useScope();
  const name = me.user.displayName || me.user.username;
  const sells = can('pos.sell');
  const approves = APPROVE_PERMS.some((p) => can(p));
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{greeting()}, {name}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {location ? <>{location.name}{location.city ? ` · ${location.city}` : ''}</> : 'No location yet'} · {org?.brand_name ?? 'K-BAY'} · {dateLabel(todayPk())}
        </p>
      </div>

      {sells && location && <SellerBlock />}

      <div className="grid gap-4 md:grid-cols-2">
        {approves && <ApprovalsTile />}
        {can('inventory.view') && location && <LowStockTile />}
      </div>

      {can('reports.view') && <MonthTile />}

      {!sells && !approves && !can('inventory.view') && !can('reports.view') && (
        <Card>
          <p className="text-sm text-[var(--muted)]">Nothing to show here yet. Use the menu to get to your pages.</p>
        </Card>
      )}
    </div>
  );
}

function BigLink({ to, children, sub, primary }: { to: string; children: ReactNode; sub?: string; primary?: boolean }) {
  return (
    <Link to={to} className={cx('flex min-h-24 flex-col justify-center rounded-2xl px-5 py-4 transition active:scale-[0.99]',
      primary ? 'bg-brand text-brand-ink hover:brightness-95' : 'border border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-2)]')}>
      <span className="text-2xl font-bold">{children}</span>
      {sub ? <span className={cx('mt-0.5 text-sm', primary ? 'text-brand-ink/80' : 'text-[var(--muted)]')}>{sub}</span> : null}
    </Link>
  );
}

function SellerBlock() {
  const { orgId, locationId, can } = useScope();
  const cur = useQuery({ queryKey: ['day', orgId, locationId], queryFn: () => get<Current>(`/orgs/${orgId}/days/current${qs({ locationId })}`),
    enabled: !!locationId, refetchInterval: 60_000 });
  const d = cur.data;
  const open = Boolean(d?.day);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <BigLink to="/pos" primary sub={open ? 'Ring up a sale' : 'Open the day first'}>Sell</BigLink>
        <BigLink to="/day" sub={open ? 'Close when done' : 'Start today'}>{open ? 'Close day' : 'Open day'}</BigLink>
      </div>
      {cur.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--muted)]"><Spinner /> Checking today…</div>
      ) : cur.error ? (
        <ErrorText error={cur.error} />
      ) : d?.day && d.figures ? (
        <Card>
          <div className="mb-2 flex items-center gap-2 text-sm text-[var(--muted)]">
            <Badge tone="good">Day open</Badge> {dateLabel(d.day.business_date)}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Sales today</div>
              <div className="mt-1 text-3xl font-bold sm:text-4xl">{rs(d.figures.sales)}</div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Profit (estimate)</div>
              <div className={cx('mt-1 text-3xl font-bold sm:text-4xl', d.figures.profit >= 0 ? 'text-[var(--good)]' : 'text-[var(--bad)]')}>{rs(d.figures.profit)}</div>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <p className="text-base font-medium">The day is not open yet.</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {can('day.open') ? 'Count the cash float and open the day to start selling.' : 'Ask your stall lead to open the day.'}
          </p>
          {can('day.open') && <Link to="/day" className="mt-3 inline-flex h-11 items-center rounded-xl bg-brand px-4 font-semibold text-brand-ink">Open the day</Link>}
        </Card>
      )}
      {d?.awaitingApproval && (
        <p className="rounded-xl bg-amber-500/15 px-3 py-2 text-sm">
          The close for <b>{dateLabel(d.awaitingApproval.business_date)}</b> is waiting for a partner's approval.
        </p>
      )}
    </div>
  );
}

function ApprovalsTile() {
  const { orgId } = useScope();
  const q = useQuery({ queryKey: ['approvals', orgId, 'pending'], queryFn: () => get<ApprovalRow[]>(`/orgs/${orgId}/approvals${qs({ status: 'pending' })}`),
    refetchInterval: 60_000 });
  const mine = (q.data ?? []).filter((a) => a.canDecide);
  return (
    <Link to="/approvals" className="block rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 hover:bg-[var(--panel-2)] sm:p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Waiting for you</div>
      {q.isLoading ? <div className="mt-2"><Spinner /></div> : q.error ? <div className="mt-2"><ErrorText error={q.error} /></div> : (
        <>
          <div className={cx('mt-1 text-4xl font-bold', mine.length > 0 && 'text-[var(--warn)]')}>{mine.length}</div>
          <div className="mt-1 text-sm text-[var(--muted)]">
            {mine.length === 0 ? 'Nothing to approve. All clear.' : `${mine.length === 1 ? 'request needs' : 'requests need'} your decision →`}
          </div>
          {mine.length > 0 && <ul className="mt-2 space-y-1 text-sm">{mine.slice(0, 3).map((a) => <li key={a.id} className="truncate">· {a.summary}</li>)}</ul>}
        </>
      )}
    </Link>
  );
}

function LowStockTile() {
  const { orgId, locationId } = useScope();
  const q = useQuery({ queryKey: ['stock', orgId, locationId], queryFn: () => get<StockRow[]>(`/orgs/${orgId}/stock${qs({ locationId })}`), enabled: !!locationId });
  const low = (q.data ?? []).filter((s) => s.is_low);
  return (
    <Card title="Low stock" actions={<Link to="/inventory" className="text-sm underline">Stock</Link>}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorText error={q.error} /> : low.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">Nothing is running low.</p>
      ) : (
        <ul className="divide-y divide-[var(--line)]">
          {low.slice(0, 6).map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate font-medium">{s.name}</span>
              <Badge tone="bad">{qtyDisplay(s.qty_display, s.purchase_unit)} left</Badge>
            </li>
          ))}
          {low.length > 6 && <li className="pt-2 text-sm text-[var(--muted)]">and {low.length - 6} more</li>}
        </ul>
      )}
    </Card>
  );
}

function MonthTile() {
  const { orgId, locationId, location } = useScope();
  const from = monthStart();
  const to = todayPk();
  // Whole business when the person can see it; a person scoped to one stall falls back to their stall.
  const q = useQuery({
    queryKey: ['home-month', orgId, locationId, from, to],
    queryFn: async () => {
      try {
        return { scope: 'All stalls', data: await get<Dashboard>(`/orgs/${orgId}/reports/dashboard${qs({ from, to })}`) };
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 403) || !locationId) throw e;
        return { scope: location?.name ?? 'This stall', data: await get<Dashboard>(`/orgs/${orgId}/reports/dashboard${qs({ from, to, locationId })}`) };
      }
    },
  });
  const d = q.data?.data;
  const month = new Date(`${to}T12:00:00`).toLocaleDateString('en-PK', { month: 'long' });
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{month} so far <span className="font-normal text-[var(--muted)]">· {q.data?.scope ?? ''}</span></h2>
        <Link to="/reports" className="text-sm underline">Reports</Link>
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorText error={q.error} /> : d && (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Sales" value={rs(d.sales)} sub={
            <>
              {d.orders.toLocaleString('en-PK')} orders · {d.plates.toLocaleString('en-PK')} plates
              {d.series.length > 1 && (
                <div className="mt-2">
                  <Sparkline values={d.series.map((s) => s.sales)}
                    label={`Daily sales this month, ${d.series.length} days, latest ${rs(d.series[d.series.length - 1]!.sales)}`} />
                </div>
              )}
            </>
          } />
          <Stat label="Profit" value={rs(d.profit)} tone={d.profit >= 0 ? 'good' : 'bad'}
            sub={d.sales > 0 ? `${Math.round((d.profit / d.sales) * 100)}% of sales` : undefined} />
        </div>
      )}
    </section>
  );
}
