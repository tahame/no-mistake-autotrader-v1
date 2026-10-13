import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post, qs } from '../api';
import { BarList, Sparkline, VIZ } from '../components/charts';
import { Badge, Button, Card, Empty, ErrorText, Loading, Money, PageHeader, Spinner, Stat, Table, useToast } from '../components/ui';
import { dateLabel, monthStart, rs, timeLabel, todayPk } from '../format';
import { useScope } from '../session';

// The investor's own view: what they put in (per stall), loans and refunds, their return, and how
// the business is doing. Capital is placed in a stall or the whole business, never with a person.

interface Txn {
  id: string; kind: string; amount_minor: number; status: string; reason: string | null; created_at: string; confirmed_at: string | null;
  loan_id: string | null; person_id: string; location_name: string | null; account_name: string | null;
}
interface Loan {
  id: string; principal_minor: number; due_date: string | null; status: 'open' | 'closed'; created_at: string; note: string | null; location_name: string | null;
  converted: number; refunded: number; in_progress: number; outstanding: number;
}
interface Position { person_id: string; key: string; location_id: string | null; location_name: string | null; balance_minor: number }
interface Capital { txns: Txn[]; loans: Loan[]; positions: Position[] }
interface StatementRow {
  personId: string; name: string; role: 'partner' | 'investor' | 'former'; sharePercent: number; earnedMinor: number; withdrawnMinor: number;
  reinvestedMinor: number; retainedMinor: number;
}
interface Partners { investors: { person_id: string; takes_return: boolean; mentorship: boolean; effective_to: string | null }[] }
interface Dashboard { sales: number; profit: number; orders: number; plates: number; series: { d: string; sales: number; profit: number }[] }
interface StallRow { location_id: string; name: string; sales_minor: number; profit_minor: number; days: number }

const KIND: Record<string, string> = {
  investment: 'Investment', loan_in: 'Loan given', loan_convert: 'Loan turned into investment', loan_refund: 'Loan refund', withdrawal: 'Withdrawal',
  reinvest: 'Profit reinvested', advance: 'Advance taken', advance_repay: 'Advance repaid',
};
const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  posted: { label: 'Done', tone: 'good' }, pending_approval: { label: 'Waiting for approval', tone: 'warn' },
  awaiting_confirmation: { label: 'Waiting for you', tone: 'warn' }, rejected: { label: 'Rejected', tone: 'bad' },
};

export function Investor() {
  const { orgId, org, me, can } = useScope();
  const personId = me.user.personId;
  const capital = useQuery({
    queryKey: ['capital', orgId, personId], enabled: !!personId,
    queryFn: () => get<Capital>(`/orgs/${orgId}/capital${qs({ personId })}`),
  });

  if (!can('investor.portal')) return <Empty>You do not have access to the investor portal.</Empty>;
  if (!personId) return <Empty>Your login is not linked to a person in this business yet. Ask an admin to link it.</Empty>;

  return (
    <div className="space-y-4">
      <PageHeader title="My investment" sub={`${me.user.displayName} · ${org.brand_name}`} />
      <div className="rounded-2xl border border-brand/40 bg-brand/10 p-4 text-sm">
        <b>You invest in the stall, not the person.</b> Your money is recorded against a stall (or the whole business) in the books,
        so it stays yours whoever runs the stall. Loans are kept separate and are paid back only after you confirm you received the money.
      </div>
      {capital.isLoading ? <Loading /> : capital.error ? <ErrorText error={capital.error} /> : capital.data && (
        <>
          <AwaitingRefunds txns={capital.data.txns} />
          <div className="grid gap-4 lg:grid-cols-2">
            <CapitalCard positions={capital.data.positions.filter((p) => p.person_id === personId)} />
            <LoansCard loans={capital.data.loans} />
          </div>
        </>
      )}
      <ReturnCard personId={personId} />
      {can('reports.view') && <Performance />}
      {capital.data && capital.data.txns.length > 0 && <History txns={capital.data.txns} />}
    </div>
  );
}

function AwaitingRefunds({ txns }: { txns: Txn[] }) {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useMutation({
    mutationFn: (id: string) => post(`/orgs/${orgId}/capital/refunds/${id}/confirm`),
    onMutate: (id) => setBusy(id),
    onSettled: () => setBusy(null),
    onSuccess: () => {
      toast('Thanks — the refund is recorded as received');
      void qc.invalidateQueries({ queryKey: ['capital'] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
  const waiting = txns.filter((t) => t.kind === 'loan_refund' && t.status === 'awaiting_confirmation');
  if (waiting.length === 0) return null;
  return (
    <Card title="Did you receive this money?" className="border-amber-500/50">
      <p className="mb-3 text-sm text-[var(--muted)]">
        The business says it paid back part of your loan. Only confirm once the money is actually with you — until then the loan stays as it was.
      </p>
      <ErrorText error={confirm.error} />
      <ul className="space-y-3">
        {waiting.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--panel-2)] p-3">
            <div>
              <div className="text-2xl font-bold">{rs(t.amount_minor)}</div>
              <div className="text-sm text-[var(--muted)]">
                Sent {timeLabel(t.created_at)}{t.account_name ? ` from ${t.account_name}` : ''}{t.location_name ? ` · ${t.location_name}` : ''}
                {t.reason ? ` · ${t.reason}` : ''}
              </div>
            </div>
            <Button variant="good" size="lg" busy={busy === t.id} disabled={busy !== null && busy !== t.id} onClick={() => confirm.mutate(t.id)}>
              Confirm I received it
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CapitalCard({ positions }: { positions: Position[] }) {
  const cap = positions.filter((p) => p.key === 'capital' && p.balance_minor !== 0);
  const groups = new Map<string, { name: string; amount: number }>();
  for (const p of cap) {
    const k = p.location_id ?? 'org';
    const g = groups.get(k) ?? { name: p.location_name ?? 'Whole business', amount: 0 };
    groups.set(k, { ...g, amount: g.amount + p.balance_minor });
  }
  const rows = [...groups.entries()].map(([k, g]) => ({ key: k, ...g })).sort((a, b) => b.amount - a.amount);
  const total = rows.reduce((a, r) => a + r.amount, 0);
  const advances = positions.filter((p) => p.key === 'advances').reduce((a, p) => a + p.balance_minor, 0);
  return (
    <Card title="Capital invested">
      <div className="mb-4">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Total</div>
        <div className="text-4xl font-bold">{rs(total)}</div>
      </div>
      {rows.length === 0 ? <Empty>No investment recorded yet.</Empty> : (
        <BarList title="Capital invested per stall" series={[{ name: 'Capital', color: VIZ.s1 }]}
          rows={rows.map((r) => ({ key: r.key, label: r.name, values: [r.amount] }))} />
      )}
      {advances < 0 && (
        <p className="mt-4 text-sm text-[var(--muted)]">You also owe the business <b className="text-[var(--ink)]">{rs(-advances)}</b> in advances.</p>
      )}
    </Card>
  );
}

function LoansCard({ loans }: { loans: Loan[] }) {
  const open = loans.filter((l) => l.status === 'open');
  const outstanding = open.reduce((a, l) => a + l.outstanding, 0);
  return (
    <Card title="Loans to the business">
      <div className="mb-4">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Still owed to you</div>
        <div className="text-4xl font-bold">{rs(outstanding)}</div>
      </div>
      {loans.length === 0 ? <Empty>You have not lent money to the business.</Empty> : (
        <ul className="divide-y divide-[var(--line)]">
          {loans.map((l) => (
            <li key={l.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{rs(l.principal_minor)} lent {dateLabel(l.created_at)}</span>
                {l.status === 'closed' ? <Badge tone="good">Paid off</Badge> : l.in_progress > 0 ? <Badge tone="warn">Refund on the way</Badge> : <Badge tone="brand">Open</Badge>}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-4">
                <span className="text-[var(--muted)]">Owed <b className="text-[var(--ink)]"><Money minor={l.outstanding} /></b></span>
                <span className="text-[var(--muted)]">Paid back <Money minor={l.refunded} /></span>
                <span className="text-[var(--muted)]">Became investment <Money minor={l.converted} /></span>
                {l.in_progress > 0 && <span className="text-[var(--muted)]">In progress <Money minor={l.in_progress} /></span>}
              </div>
              <div className="mt-1 text-xs text-[var(--muted)]">
                {l.location_name ?? 'Whole business'}{l.due_date ? ` · due ${dateLabel(l.due_date)}` : ' · no due date'}{l.note ? ` · ${l.note}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReturnCard({ personId }: { personId: string }) {
  const { orgId, can } = useScope();
  const from = monthStart();
  const to = todayPk();
  const allowed = can('reports.partners');
  // Your own line only; the server allows it without partner-report rights.
  const stmt = useQuery({ queryKey: ['partner-statement', orgId, from, to, personId],
    queryFn: () => get<StatementRow[]>(`/orgs/${orgId}/partners/statement${qs({ from, to, personId })}`) });
  const partners = useQuery({ queryKey: ['partners', orgId], enabled: allowed, queryFn: () => get<Partners>(`/orgs/${orgId}/partners`) });

  if (stmt.isLoading || (allowed && partners.isLoading)) return <Card title="Your return"><Spinner /></Card>;
  if (stmt.error) return <Card title="Your return"><ErrorText error={stmt.error} /></Card>;

  const row = stmt.data?.find((r) => r.personId === personId);
  const terms = partners.data?.investors.find((t) => t.person_id === personId && t.effective_to === null);
  const takesReturn = row && row.role !== 'former';

  return (
    <Card title="Your return">
      {takesReturn ? (
        <>
          <p className="mb-3 text-sm text-[var(--muted)]">
            You get <b className="text-[var(--ink)]">{row.sharePercent}%</b> of the profit{row.role === 'partner' ? ' as a partner' : ' as an investor'}. This month so far:
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Earned this month" value={rs(row.earnedMinor)} tone={row.earnedMinor >= 0 ? 'good' : 'bad'} />
            <Stat label="Taken out" value={rs(row.withdrawnMinor)} />
            <Stat label="Reinvested" value={rs(row.reinvestedMinor)} />
            <Stat label="Yours, not yet taken" value={rs(row.retainedMinor)} sub="All time" />
          </div>
        </>
      ) : (
        <>
          <p className="text-base">
            <b>You take no return in this business.</b>{' '}
            {terms?.mentorship ? 'You support it as a mentor; your money works for the stall.' : 'Your money works for the stall; no profit share is paid to you.'}
          </p>
          {row && row.retainedMinor !== 0 && (
            <p className="mt-2 text-sm text-[var(--muted)]">From an earlier share, <b className="text-[var(--ink)]">{rs(row.retainedMinor)}</b> is still yours and not yet taken out.</p>
          )}
        </>
      )}
    </Card>
  );
}

function Performance() {
  const { orgId } = useScope();
  const from = monthStart();
  const to = todayPk();
  const dash = useQuery({ queryKey: ['report', 'dashboard', orgId, from, to, 'all'],
    queryFn: () => get<Dashboard>(`/orgs/${orgId}/reports/dashboard${qs({ from, to })}`) });
  const stalls = useQuery({ queryKey: ['report', 'stalls', orgId, from, to, 'all'],
    queryFn: () => get<StallRow[]>(`/orgs/${orgId}/reports/stalls${qs({ from, to })}`) });
  const month = new Date(`${to}T12:00:00`).toLocaleDateString('en-PK', { month: 'long' });
  const d = dash.data;
  return (
    <Card title={`How the business is doing — ${month} so far`}>
      {dash.isLoading ? <Spinner /> : dash.error ? <ErrorText error={dash.error} /> : d && (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Sales" value={rs(d.sales)} sub={
            <>
              {d.orders.toLocaleString('en-PK')} orders · {d.plates.toLocaleString('en-PK')} plates
              {d.series.length > 1 && <div className="mt-2"><Sparkline values={d.series.map((s) => s.sales)} label={`Daily sales in ${month}`} /></div>}
            </>
          } />
          <Stat label="Profit" value={rs(d.profit)} tone={d.profit >= 0 ? 'good' : 'bad'}
            sub={d.sales > 0 ? `${Math.round((d.profit / d.sales) * 100)}% of sales` : undefined} />
        </div>
      )}
      <h3 className="mb-3 mt-5 text-sm font-semibold">Stall by stall</h3>
      {stalls.isLoading ? <Spinner /> : stalls.error ? <ErrorText error={stalls.error} /> : (stalls.data ?? []).length === 0 ? <Empty>No stalls yet.</Empty> : (
        <BarList title="Sales and profit per stall this month" series={[{ name: 'Sales', color: VIZ.s1 }, { name: 'Profit', color: VIZ.s2 }]}
          rows={stalls.data!.map((s) => ({ key: s.location_id, label: `${s.name}${s.days ? ` · ${s.days} days open` : ''}`, values: [s.sales_minor, s.profit_minor] }))} />
      )}
    </Card>
  );
}

function History({ txns }: { txns: Txn[] }) {
  return (
    <Card title="Everything recorded for you">
      <Table rows={txns} rowKey={(t) => t.id}
        columns={[
          { label: 'Date', render: (t) => dateLabel(t.created_at) },
          { label: 'What', render: (t) => KIND[t.kind] ?? t.kind },
          { label: 'Where', render: (t) => t.location_name ?? 'Whole business', hideOnMobile: true },
          { label: 'Status', render: (t) => <Badge tone={STATUS[t.status]?.tone ?? 'neutral'}>{STATUS[t.status]?.label ?? t.status}</Badge> },
          { label: 'Amount', align: 'right', render: (t) => <Money minor={t.amount_minor} /> },
        ]} />
    </Card>
  );
}
