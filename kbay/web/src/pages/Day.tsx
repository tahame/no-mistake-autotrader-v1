import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, qs } from '../api';
import { Badge, Button, Card, Empty, ErrorText, Field, Loading, Money, MoneyInput, PageHeader, Select, Stat, Table, Textarea, useToast } from '../components/ui';
import { dateLabel, rs, timeLabel } from '../format';
import { useScope } from '../session';

interface Figures {
  sales: number; refunds: number; cogs: number; waste: number; other_expenses: number; revenue: number; expenses: number; profit: number;
  flows: { money_account_id: string; name: string; kind: string; in_minor: number; out_minor: number }[];
}
interface Current {
  day: { id: string; business_date: string; opening_float_minor: number; opened_at: string } | null;
  figures: Figures | null;
  drawer: { id: string; name: string; balance: number } | null;
  awaitingApproval: { id: string; business_date: string } | null;
}
interface Account { id: string; name: string; kind: string; active: boolean; location_id: string | null }
interface Person { id: string; full_name: string; display_name: string | null }

export function Day() {
  const { orgId, locationId, location, can } = useScope();
  const cur = useQuery({ queryKey: ['day', orgId, locationId], queryFn: () => get<Current>(`/orgs/${orgId}/days/current${qs({ locationId })}`), enabled: !!locationId });
  const [closing, setClosing] = useState(false);
  if (!location) return <Empty>No location yet.</Empty>;
  if (cur.isLoading) return <Loading />;
  const d = cur.data!;
  return (
    <>
      <PageHeader title="Business day" sub={`${location.name}`} />
      {d.awaitingApproval && (
        <div className="mb-4 rounded-xl bg-amber-500/15 p-3 text-sm">
          The close for <b>{dateLabel(d.awaitingApproval.business_date)}</b> is waiting for a partner's approval. <Link className="underline" to="/approvals">See approvals</Link>
        </div>
      )}
      {!d.day ? (can('day.open') ? <OpenDay current={d} /> : <Empty>The day is not open yet.</Empty>) : closing ? (
        <CloseDay dayId={d.day.id} onDone={() => setClosing(false)} />
      ) : (
        <OpenDayView current={d} onClose={() => setClosing(true)} canClose={can('day.close')} />
      )}
      <History />
    </>
  );
}

function OpenDay({ current }: { current: Current }) {
  const { orgId, locationId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const people = useQuery({ queryKey: ['people', orgId], queryFn: () => get<Person[]>(`/orgs/${orgId}/people`) });
  const accounts = useQuery({ queryKey: ['accounts', orgId], queryFn: () => get<Account[]>(`/orgs/${orgId}/money-accounts`) });
  const books = current.drawer?.balance ?? 0;
  const [float, setFloat] = useState<number | null>(books > 0 ? books : null);
  const [source, setSource] = useState<'account' | 'investment' | 'variance'>('account');
  const [sourceId, setSourceId] = useState('');
  const [note, setNote] = useState('');
  const diff = (float ?? 0) - books;
  const open = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/days/open`, {
      locationId, openingFloatMinor: float ?? 0, note: note || undefined,
      floatSource: diff === 0 || source === 'variance' ? null : source === 'account' ? { kind: 'account', accountId: sourceId } : { kind: 'investment', personId: sourceId },
    }),
    onSuccess: () => { toast('Day opened'); void qc.invalidateQueries({ queryKey: ['day'] }); },
  });
  const needsSource = diff !== 0 && source !== 'variance' && !sourceId;
  return (
    <Card title="Open the day">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3">
          <Field label="Cash float in the drawer" hint={`The books say ${current.drawer?.name ?? 'the drawer'} should hold ${rs(books)}.`}>
            <MoneyInput value={float} onChange={setFloat} autoFocus />
          </Field>
          {float !== null && diff !== 0 && (
            <div className="space-y-3 rounded-xl bg-[var(--panel-2)] p-3">
              <p className="text-sm">
                The drawer has <b>{rs(Math.abs(diff))} {diff > 0 ? 'more' : 'less'}</b> than the books. {diff > 0 ? 'Where did it come from?' : 'Where did it go?'}
              </p>
              <Select value={source} onChange={(e) => { setSource(e.target.value as typeof source); setSourceId(''); }} options={[
                { value: 'account', label: diff > 0 ? 'Brought from an account' : 'Moved to an account' },
                ...(diff > 0 ? [{ value: 'investment', label: 'Put in by a person (investment)' }] : []),
                { value: 'variance', label: 'Not sure — record as a cash difference' },
              ]} />
              {source === 'account' && (
                <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)} placeholder="Pick the account"
                  options={(accounts.data ?? []).filter((a) => a.active && a.id !== current.drawer?.id).map((a) => ({ value: a.id, label: a.name }))} />
              )}
              {source === 'investment' && (
                <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)} placeholder="Who put it in?"
                  options={(people.data ?? []).map((p) => ({ value: p.id, label: p.display_name ?? p.full_name }))} />
              )}
            </div>
          )}
        </div>
        <div className="space-y-3">
          <Field label="Stock check / notes" hint="Anything low? You can also raise a stock request from Stock.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. oil about half, 1 gas cylinder full" />
          </Field>
          <Link to="/inventory" className="text-sm underline">Raise a stock request</Link>
        </div>
      </div>
      <ErrorText error={open.error} />
      <Button variant="primary" size="lg" className="mt-4 w-full sm:w-auto" disabled={float === null || needsSource} busy={open.isPending} onClick={() => open.mutate()}>
        Open the day
      </Button>
    </Card>
  );
}

function OpenDayView({ current, onClose, canClose }: { current: Current; onClose: () => void; canClose: boolean }) {
  const f = current.figures!;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
        <Badge tone="good">Open</Badge> Day of {dateLabel(current.day!.business_date)} · opened {timeLabel(current.day!.opened_at)} · float {rs(current.day!.opening_float_minor)}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sales" value={rs(f.sales)} />
        <Stat label="Cost of food used" value={rs(f.cogs)} sub="Estimated from recipes" />
        <Stat label="Other costs" value={rs(f.other_expenses + f.waste)} />
        <Stat label="Profit (estimate)" value={rs(f.profit)} tone={f.profit >= 0 ? 'good' : 'bad'} />
      </div>
      <Card title="Money moved today">
        <Table rows={f.flows} rowKey={(r) => r.money_account_id} empty="No money has moved yet today."
          columns={[
            { label: 'Account', render: (r) => r.name },
            { label: 'In', align: 'right', render: (r) => <Money minor={r.in_minor} /> },
            { label: 'Out', align: 'right', render: (r) => <Money minor={r.out_minor} /> },
          ]} />
      </Card>
      {canClose && <Button variant="primary" size="lg" className="w-full sm:w-auto" onClick={onClose}>Close the day</Button>}
    </div>
  );
}

interface Preview {
  figures: Figures;
  expected: { moneyAccountId: string; name: string; kind: string; expectedMinor: number; mode: 'count' | 'confirm' }[];
  problems: string[];
}

function CloseDay({ dayId, onDone }: { dayId: string; onDone: () => void }) {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const prev = useQuery({ queryKey: ['close-preview', dayId], queryFn: () => get<Preview>(`/orgs/${orgId}/days/${dayId}/close-preview`) });
  const accounts = useQuery({ queryKey: ['accounts', orgId], queryFn: () => get<Account[]>(`/orgs/${orgId}/money-accounts`) });
  const [declared, setDeclared] = useState<Record<string, number | null>>({});
  const [transfers, setTransfers] = useState<{ from: string; to: string; amount: number | null }[]>([]);
  const [note, setNote] = useState('');
  const submit = useMutation({
    mutationFn: () => post<{ differenceMinor: number }>(`/orgs/${orgId}/days/${dayId}/close`, {
      declared: Object.entries(declared).filter(([, v]) => v !== null).map(([moneyAccountId, v]) => ({ moneyAccountId, declaredMinor: v })),
      transfers: transfers.filter((t) => t.from && t.to && t.amount).map((t) => ({ fromAccountId: t.from, toAccountId: t.to, amountMinor: t.amount })),
      note: note || undefined,
    }),
    onSuccess: () => { toast('Close sent for approval'); void qc.invalidateQueries({ queryKey: ['day'] }); onDone(); },
  });
  if (prev.isLoading) return <Loading />;
  const p = prev.data!;
  // Expected after the transfers typed here (they are posted first on submit).
  const moved = (id: string) => transfers.reduce((a, t) => a + (t.amount ?? 0) * ((t.to === id ? 1 : 0) - (t.from === id ? 1 : 0)), 0);
  const expectedAfter = (e: Preview['expected'][number]) => e.expectedMinor + moved(e.moneyAccountId);
  const diffTotal = p.expected.reduce((a, e) => a + (declared[e.moneyAccountId] ?? expectedAfter(e)) - expectedAfter(e), 0);
  const missing = p.expected.some((e) => e.mode === 'count' && declared[e.moneyAccountId] == null);
  const accts = (accounts.data ?? []).filter((a) => a.active);

  return (
    <div className="space-y-4">
      {p.problems.length > 0 && (
        <div className="rounded-xl bg-red-600/10 p-3 text-sm text-[var(--bad)]">{p.problems.map((x) => <div key={x}>{x}</div>)}</div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sales" value={rs(p.figures.sales)} />
        <Stat label="Refunds" value={rs(p.figures.refunds)} />
        <Stat label="Costs" value={rs(p.figures.expenses)} />
        <Stat label="Profit (estimate)" value={rs(p.figures.profit)} tone={p.figures.profit >= 0 ? 'good' : 'bad'} />
      </div>
      <Card title="Cash moved to another account at close" actions={<Button size="sm" onClick={() => setTransfers((t) => [...t, { from: p.expected.find((e) => e.kind === 'cash')?.moneyAccountId ?? '', to: '', amount: null }])}>Add</Button>}>
        {transfers.length === 0 ? <p className="text-sm text-[var(--muted)]">E.g. cash deposited into a bank account. Leave empty if all cash stays in the drawer.</p> : (
          <div className="space-y-2">
            {transfers.map((t, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_160px_auto]">
                <Select value={t.from} onChange={(e) => setTransfers((x) => x.map((y, j) => (j === i ? { ...y, from: e.target.value } : y)))} placeholder="From" options={accts.map((a) => ({ value: a.id, label: a.name }))} />
                <Select value={t.to} onChange={(e) => setTransfers((x) => x.map((y, j) => (j === i ? { ...y, to: e.target.value } : y)))} placeholder="To" options={accts.map((a) => ({ value: a.id, label: a.name }))} />
                <MoneyInput value={t.amount} onChange={(v) => setTransfers((x) => x.map((y, j) => (j === i ? { ...y, amount: v } : y)))} />
                <Button size="md" variant="ghost" onClick={() => setTransfers((x) => x.filter((_, j) => j !== i))} aria-label="Remove">✕</Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title="Count and confirm">
        <div className="space-y-3">
          {p.expected.map((e) => {
            const exp = expectedAfter(e);
            const dec = declared[e.moneyAccountId];
            const diff = dec == null ? null : dec - exp;
            return (
              <div key={e.moneyAccountId} className="grid items-end gap-2 sm:grid-cols-[1fr_200px_140px]">
                <div>
                  <div className="font-medium">{e.name}</div>
                  <div className="text-sm text-[var(--muted)]">{e.mode === 'count' ? 'Count the cash in the drawer' : 'Confirm the amount received today'} · books say {rs(exp)}</div>
                </div>
                {/* Wallet/bank lines left empty are taken as matching the books. */}
                <MoneyInput value={dec ?? null} onChange={(v) => setDeclared((d) => ({ ...d, [e.moneyAccountId]: v }))} aria-label={`Amount for ${e.name}`}
                  placeholder={e.mode === 'confirm' ? `${(exp / 100).toLocaleString('en-PK')} (as books)` : 'Counted'} />
                <div className="text-right text-sm">
                  {diff === null ? (e.mode === 'confirm' ? <Badge tone="good">As books</Badge> : null) : diff === 0 ? <Badge tone="good">Matches</Badge> : <Badge tone={diff < 0 ? 'bad' : 'warn'}>{diff < 0 ? 'Short' : 'Over'} {rs(Math.abs(diff))}</Badge>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <Field label="Note for the approver"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorText error={submit.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" disabled={missing || p.problems.length > 0} busy={submit.isPending} onClick={() => submit.mutate()}>
          Submit close{diffTotal !== 0 ? ` (${diffTotal < 0 ? 'short' : 'over'} ${rs(Math.abs(diffTotal))})` : ''}
        </Button>
        <Button variant="ghost" onClick={onDone}>Back</Button>
      </div>
      <p className="text-xs text-[var(--muted)]">After submitting, a partner approves the close and the day locks. Sales stop until the next day is opened.</p>
    </div>
  );
}

function History() {
  const { orgId, locationId, can } = useScope();
  const days = useQuery({ queryKey: ['days', orgId, locationId], queryFn: () => get<{ id: string; business_date: string; status: string; sales_minor: number; opened_by_name: string }[]>(`/orgs/${orgId}/days${qs({ locationId })}`),
    enabled: can('reports.view') });
  if (!can('reports.view')) return null;
  return (
    <Card title="Recent days" className="mt-6">
      <Table rows={days.data ?? []} rowKey={(r) => r.id} empty="No days yet."
        columns={[
          { label: 'Date', render: (r) => dateLabel(r.business_date) },
          { label: 'Status', render: (r) => <Badge tone={r.status === 'approved' ? 'good' : r.status === 'submitted' ? 'warn' : 'brand'}>{r.status === 'approved' ? 'Locked' : r.status === 'submitted' ? 'Waiting approval' : 'Open'}</Badge> },
          { label: 'Opened by', render: (r) => r.opened_by_name, hideOnMobile: true },
          { label: 'Sales', align: 'right', render: (r) => <Money minor={r.sales_minor} /> },
        ]} />
    </Card>
  );
}
