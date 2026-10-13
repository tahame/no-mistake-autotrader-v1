import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, patch, post, qs } from '../api';
import {
  Badge, Button, Card, cx, Empty, ErrorText, Field, Input, Loading, Modal, Money, MoneyInput, PageHeader, Select, Stat, Table, Tabs, Textarea, useToast,
} from '../components/ui';
import { dateLabel, monthStart, rs, timeLabel, todayPk } from '../format';
import { useScope } from '../session';

// ---------- Shared types and helpers ----------

type Kind = 'cash' | 'easypaisa' | 'jazzcash' | 'nayapay' | 'sadapay' | 'bank' | 'other';
interface Account {
  id: string; name: string; kind: Kind; location_id: string | null; location_name: string | null; owner_person_id: string | null;
  owner_name: string | null; active: boolean; balance_minor: number | null;
}
interface Person { id: string; full_name: string; display_name: string | null; user_id: string | null }

const KIND_LABEL: Record<Kind, string> = {
  cash: 'Cash drawer', easypaisa: 'Easypaisa', jazzcash: 'JazzCash', nayapay: 'NayaPay', sadapay: 'SadaPay', bank: 'Bank', other: 'Other',
};
const pname = (p: Person) => p.display_name ?? p.full_name;

function usePeople() {
  const { orgId } = useScope();
  return useQuery({ queryKey: ['people', orgId], queryFn: () => get<Person[]>(`/orgs/${orgId}/people`) });
}
function useAccounts() {
  const { orgId } = useScope();
  return useQuery({ queryKey: ['accounts', orgId], queryFn: () => get<Account[]>(`/orgs/${orgId}/money-accounts`) });
}
function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => { for (const k of keys) void qc.invalidateQueries({ queryKey: [k] }); };
}

/** Two or three big buttons instead of a toggle: easier to hit on a phone. */
function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex gap-1 rounded-xl bg-[var(--panel-2)] p-1" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cx('h-10 flex-1 rounded-lg px-3 text-sm font-medium', value === o.value ? 'bg-[var(--panel)] shadow-sm' : 'text-[var(--muted)]')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PersonSelect({ value, onChange, placeholder = 'Pick a person', filter }: { value: string; onChange: (v: string) => void; placeholder?: string;
  filter?: (p: Person) => boolean }) {
  const people = usePeople();
  return <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    options={(people.data ?? []).filter(filter ?? (() => true)).map((p) => ({ value: p.id, label: pname(p) }))} />;
}

function AccountSelect({ value, onChange, placeholder = 'Pick an account', exclude, showBalance }: { value: string; onChange: (v: string) => void;
  placeholder?: string; exclude?: string; showBalance?: boolean }) {
  const accounts = useAccounts();
  return <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    options={(accounts.data ?? []).filter((a) => a.active && a.id !== exclude)
      .map((a) => ({ value: a.id, label: `${a.name}${showBalance && a.balance_minor != null ? ` (${rs(a.balance_minor)})` : ''}` }))} />;
}

function LocationSelect({ value, onChange, placeholder = 'Whole business' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const { org } = useScope();
  return <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    options={org.locations.map((l) => ({ value: l.id, label: l.name }))} />;
}

// ---------- Page ----------

type TabKey = 'accounts' | 'partners' | 'capital' | 'staff';

export function MoneyPage() {
  const { can, me } = useScope();
  const params = useParams();
  const nav = useNavigate();
  const sub = (params['*'] ?? '').split('/')[0] as TabKey | '';
  const tabs: { value: TabKey; label: string }[] = [];
  if (can('finance.view')) tabs.push({ value: 'accounts', label: 'Accounts' });
  if (can('reports.partners')) tabs.push({ value: 'partners', label: 'Partners' });
  // A lender without capital rights still lands here from the "confirm you received it" notification.
  if (can('reports.partners') || can('capital.manage') || can('capital.withdraw') || (sub === 'capital' && me.user.personId)) {
    tabs.push({ value: 'capital', label: 'Capital' });
  }
  if (can('payroll.manage')) tabs.push({ value: 'staff', label: 'Staff & wages' });
  const tab = tabs.find((t) => t.value === sub)?.value ?? tabs[0]?.value;

  if (!tab) return <><PageHeader title="Money" /><Empty>You don't have access to money pages.</Empty></>;
  return (
    <>
      <PageHeader title="Money" sub="Accounts, partners, capital and wages" />
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={(v) => nav(`/money/${v}`)} />}
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'partners' && <PartnersTab />}
      {tab === 'capital' && <CapitalTab />}
      {tab === 'staff' && <StaffTab />}
    </>
  );
}

// ---------- 1. Accounts ----------

function AccountsTab() {
  const { can } = useScope();
  const accounts = useAccounts();
  const [open, setOpen] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [moving, setMoving] = useState(false);
  const list = accounts.data ?? [];
  const active = list.filter((a) => a.active);
  const total = active.reduce((s, a) => s + (a.balance_minor ?? 0), 0);
  const canMove = can('accounts.manage') || can('day.close');

  if (accounts.isLoading) return <Loading />;
  return (
    <div className="space-y-4">
      <ErrorText error={accounts.error} />
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Stat label="Total in all accounts" value={rs(total)} sub={`${active.length} active account${active.length === 1 ? '' : 's'}`} />
        <div className="flex flex-wrap gap-2">
          {canMove && <Button variant="primary" size="lg" className="flex-1 sm:flex-none" onClick={() => setMoving(true)}>Move money</Button>}
          {can('accounts.manage') && <Button size="lg" className="flex-1 sm:flex-none" onClick={() => setEditing('new')}>Add account</Button>}
        </div>
      </div>
      {list.length === 0 ? <Empty>No money accounts yet.</Empty> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((a) => (
            <button key={a.id} onClick={() => setOpen(a)}
              className={cx('rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 text-left transition active:scale-[0.99] hover:bg-[var(--panel-2)]', !a.active && 'opacity-60')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{a.name}</div>
                  <div className="mt-0.5 text-sm text-[var(--muted)]">
                    {[a.owner_name ? `${a.owner_name}'s` : null, a.location_name].filter(Boolean).join(' · ') || 'Business'}
                  </div>
                </div>
                <Badge tone={a.kind === 'cash' ? 'brand' : 'neutral'}>{KIND_LABEL[a.kind]}</Badge>
              </div>
              <div className="mt-3 flex items-end justify-between">
                <Money minor={a.balance_minor} className="text-2xl font-bold" />
                {!a.active && <Badge tone="bad">Switched off</Badge>}
              </div>
            </button>
          ))}
        </div>
      )}
      {open && <StatementSheet account={open} onClose={() => setOpen(null)} onEdit={can('accounts.manage') ? () => { setEditing(open); setOpen(null); } : undefined} />}
      {editing && <AccountForm account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {moving && <TransferForm onClose={() => setMoving(false)} />}
    </div>
  );
}

interface StatementLine { entry_id: string; entry_date: string; memo: string; source_type: string; created_at: string; debit_minor: number; credit_minor: number; running_minor: number }

function StatementSheet({ account, onClose, onEdit }: { account: Account; onClose: () => void; onEdit?: () => void }) {
  const { orgId } = useScope();
  const st = useQuery({ queryKey: ['statement', account.id], queryFn: () => get<StatementLine[]>(`/orgs/${orgId}/money-accounts/${account.id}/statement`) });
  return (
    <Modal open onClose={onClose} title={account.name} wide footer={onEdit ? <Button onClick={onEdit}>Edit account</Button> : undefined}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div className="text-sm text-[var(--muted)]">
          {KIND_LABEL[account.kind]}{account.owner_name ? ` · held by ${account.owner_name}` : ''}{account.location_name ? ` · ${account.location_name}` : ''}
        </div>
        <div className="text-right"><div className="text-xs text-[var(--muted)]">Balance</div><Money minor={account.balance_minor} className="text-2xl font-bold" /></div>
      </div>
      <ErrorText error={st.error} />
      {st.isLoading ? <Loading /> : (
        <Table rows={st.data ?? []} rowKey={(r) => `${r.entry_id}:${r.running_minor}:${r.debit_minor}:${r.credit_minor}`} empty="No money has moved through this account yet."
          columns={[
            { label: 'Date', render: (r) => dateLabel(r.entry_date) },
            { label: 'What', render: (r) => <span className="text-left">{r.memo}</span>, className: 'max-w-xs' },
            { label: 'In', align: 'right', render: (r) => (r.debit_minor ? <Money minor={r.debit_minor} className="text-[var(--good)]" /> : '') },
            { label: 'Out', align: 'right', render: (r) => (r.credit_minor ? <Money minor={r.credit_minor} /> : '') },
            { label: 'Balance', align: 'right', render: (r) => <Money minor={r.running_minor} />, hideOnMobile: true },
          ]} />
      )}
      {(st.data?.length ?? 0) >= 300 && <p className="mt-2 text-xs text-[var(--muted)]">Showing the latest 300 movements.</p>}
    </Modal>
  );
}

function AccountForm({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const inv = useInvalidate();
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<Kind>(account?.kind ?? 'cash');
  const [owner, setOwner] = useState(account?.owner_person_id ?? '');
  const [loc, setLoc] = useState(account?.location_id ?? '');
  const [active, setActive] = useState(account?.active ?? true);
  const save = useMutation({
    mutationFn: () => account
      ? patch(`/orgs/${orgId}/money-accounts/${account.id}`, { name: name.trim(), ownerPersonId: owner || null, locationId: loc || null, active })
      : post(`/orgs/${orgId}/money-accounts`, { name: name.trim(), kind, ownerPersonId: owner || null, locationId: loc || null }),
    onSuccess: () => { toast(account ? 'Account saved' : 'Account added'); inv('accounts'); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={account ? 'Edit account' : 'Add account'}
      footer={<Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={name.trim().length < 2} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="space-y-3">
        <Field label="Name" hint="e.g. Taha's JazzCash, Meezan bank, Clifton drawer">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        {account ? (
          <p className="text-sm text-[var(--muted)]">Type: {KIND_LABEL[account.kind]} (cannot be changed)</p>
        ) : (
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)} options={(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
          </Field>
        )}
        <Field label="Whose account is it?" hint="Wallets and banks are often in a partner's name.">
          <PersonSelect value={owner} onChange={setOwner} placeholder="The business (no one person)" />
        </Field>
        <Field label="Stall" hint={kind === 'cash' ? 'A cash drawer belongs to one stall.' : 'Leave empty if it is used by the whole business.'}>
          <LocationSelect value={loc} onChange={setLoc} />
        </Field>
        {account && (
          <Field label="Status">
            <Choice value={active ? 'on' : 'off'} onChange={(v) => setActive(v === 'on')} options={[{ value: 'on', label: 'In use' }, { value: 'off', label: 'Switched off' }]} />
          </Field>
        )}
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

function TransferForm({ onClose }: { onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const inv = useInvalidate();
  const accounts = useAccounts();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const fromAcct = accounts.data?.find((a) => a.id === from);
  const toAcct = accounts.data?.find((a) => a.id === to);
  const move = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/transfers`, { fromAccountId: from, toAccountId: to, amountMinor: amount, note: note.trim() || undefined,
      locationId: fromAcct?.location_id ?? toAcct?.location_id ?? null }),
    onSuccess: () => { toast(`Moved ${rs(amount)}`); inv('accounts', 'statement', 'day'); onClose(); },
  });
  const over = fromAcct?.balance_minor != null && amount != null && amount > fromAcct.balance_minor;
  return (
    <Modal open onClose={onClose} title="Move money"
      footer={<Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!from || !to || from === to || !amount} busy={move.isPending} onClick={() => move.mutate()}>
        Move {amount ? rs(amount) : ''}</Button>}>
      <div className="space-y-3">
        <Field label="From"><AccountSelect value={from} onChange={setFrom} exclude={to} showBalance /></Field>
        <Field label="To"><AccountSelect value={to} onChange={setTo} exclude={from} showBalance /></Field>
        <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} /></Field>
        {over && <p className="rounded-xl bg-amber-500/15 p-2 text-sm text-[var(--warn)]">That is more than the books say {fromAcct!.name} holds ({rs(fromAcct!.balance_minor)}).</p>}
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. cash deposited at bank" /></Field>
        <ErrorText error={move.error} />
      </div>
    </Modal>
  );
}

// ---------- 2. Partners ----------

interface Share { id: string; person_id: string; name: string; weight: string; effective_from: string; effective_to: string | null; percent?: number }
interface InvestorTerm { id: string; person_id: string; name: string; takes_return: boolean; return_weight: string; mentorship: boolean; effective_from: string; effective_to: string | null }
interface Proposal { id: string; shares: { personId: string; weight: number }[]; effective_from: string; reason: string | null; status: string; created_at: string }
interface Partners { current: (Share & { percent: number })[]; history: Share[]; investors: InvestorTerm[]; proposals: Proposal[] }
interface StatementRow { personId: string; name: string; role: 'partner' | 'investor' | 'former'; sharePercent: number; earnedMinor: number; withdrawnMinor: number;
  reinvestedMinor: number; retainedMinor: number }

const fmtNum = (n: number) => n.toLocaleString('en-PK', { maximumFractionDigits: 2 });

function PartnersTab() {
  const { orgId, can } = useScope();
  const people = usePeople();
  const q = useQuery({ queryKey: ['partners', orgId], queryFn: () => get<Partners>(`/orgs/${orgId}/partners`) });
  const [proposing, setProposing] = useState(false);
  const [terms, setTerms] = useState<InvestorTerm | 'new' | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorText error={q.error} />;
  const d = q.data;
  const pending = d.proposals.find((p) => p.status === 'pending_approval');
  const nameOf = (id: string) => { const p = people.data?.find((x) => x.id === id); return p ? pname(p) : d.current.find((c) => c.person_id === id)?.name ?? '?'; };
  const partnerTotal = d.current.reduce((s, c) => s + Number(c.weight), 0);
  const currentInvestors = d.investors.filter((i) => !i.effective_to);

  return (
    <div className="space-y-4">
      {pending && (
        <div className="rounded-xl bg-amber-500/15 p-3 text-sm">
          A share change from <b>{dateLabel(pending.effective_from)}</b> is waiting for approval: {pending.shares.map((s) => nameOf(s.personId)).join(', ')}.{' '}
          <Link to="/approvals" className="underline">See approvals</Link>
        </div>
      )}
      <Card title="Who owns what today" actions={can('partners.manage') ? (
        <Button size="sm" variant="primary" disabled={!!pending} onClick={() => setProposing(true)}>Propose share change</Button>) : undefined}>
        {d.current.length === 0 ? <Empty>No partners set up yet.</Empty> : (
          <ul className="divide-y divide-[var(--line)]">
            {d.current.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-sm text-[var(--muted)]">Since {dateLabel(s.effective_from)} · weight {fmtNum(Number(s.weight))}</div>
                </div>
                <div className="text-2xl font-bold tabular">{fmtNum(s.percent)}%</div>
              </li>
            ))}
          </ul>
        )}
        {(d.history.length > 0 || d.proposals.length > 0) && (
          <button className="mt-2 h-10 text-sm underline" onClick={() => setShowHistory((v) => !v)}>{showHistory ? 'Hide history' : 'Show history'}</button>
        )}
        {showHistory && (
          <div className="mt-2 space-y-4">
            {d.history.length > 0 && (
              <Table rows={d.history} rowKey={(r) => r.id} columns={[
                { label: 'Person', render: (r) => r.name },
                { label: 'Weight', align: 'right', render: (r) => fmtNum(Number(r.weight)) },
                { label: 'From', render: (r) => dateLabel(r.effective_from) },
                { label: 'To', render: (r) => dateLabel(r.effective_to) },
              ]} />
            )}
            {d.proposals.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Share changes asked for</h3>
                <ul className="space-y-2 text-sm">
                  {d.proposals.map((p) => {
                    const sum = p.shares.reduce((a, s) => a + s.weight, 0);
                    return (
                      <li key={p.id} className="rounded-xl border border-[var(--line)] p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>From <b>{dateLabel(p.effective_from)}</b></span>
                          <Badge tone={p.status === 'applied' ? 'good' : p.status === 'rejected' ? 'bad' : 'warn'}>
                            {p.status === 'applied' ? 'Applied' : p.status === 'rejected' ? 'Rejected' : 'Waiting approval'}</Badge>
                        </div>
                        <div className="mt-1 text-[var(--muted)]">{p.shares.map((s) => `${nameOf(s.personId)} ${fmtNum((s.weight / sum) * 100)}%`).join(' · ')}</div>
                        {p.reason && <div className="mt-1">{p.reason}</div>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Investors" actions={can('partners.manage') ? <Button size="sm" onClick={() => setTerms('new')}>Set investor terms</Button> : undefined}>
        {currentInvestors.length === 0 ? <p className="text-sm text-[var(--muted)]">No investor terms set.</p> : (
          <ul className="divide-y divide-[var(--line)]">
            {currentInvestors.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <div className="font-medium">{i.name}</div>
                  <div className="text-sm text-[var(--muted)]">
                    {i.takes_return ? `Takes a return (weight ${fmtNum(Number(i.return_weight))}, about ${fmtNum((Number(i.return_weight) / (partnerTotal + Number(i.return_weight))) * 100)}%)` : 'No return'}
                    {' · '}{i.mentorship ? 'Mentors' : 'No mentorship'} · since {dateLabel(i.effective_from)}
                  </div>
                </div>
                {can('partners.manage') && <Button size="sm" variant="ghost" onClick={() => setTerms(i)}>Change</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PartnerStatement />

      {proposing && <ProposeShares current={d.current} onClose={() => setProposing(false)} />}
      {terms && <InvestorTermsForm term={terms === 'new' ? null : terms} partnerTotal={partnerTotal} onClose={() => setTerms(null)} />}
    </div>
  );
}

function PartnerStatement() {
  const { orgId } = useScope();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayPk());
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const st = useQuery({ queryKey: ['partners', orgId, 'statement', from, to], queryFn: () => get<StatementRow[]>(`/orgs/${orgId}/partners/statement${qs({ from, to })}`),
    enabled: ok });
  const rows = st.data ?? [];
  const sum = (k: keyof Pick<StatementRow, 'earnedMinor' | 'withdrawnMinor' | 'reinvestedMinor' | 'retainedMinor'>) => rows.reduce((a, r) => a + r[k], 0);
  return (
    <Card title="Partner statement">
      <div className="mb-3 grid grid-cols-2 gap-2 sm:max-w-md">
        <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {!ok && <p className="text-sm text-[var(--bad)]">Pick a start date before the end date.</p>}
      <ErrorText error={st.error} />
      {st.isLoading && ok ? <Loading /> : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Profit earned" value={rs(sum('earnedMinor'))} tone={sum('earnedMinor') < 0 ? 'bad' : undefined} />
            <Stat label="Taken out" value={rs(sum('withdrawnMinor'))} />
            <Stat label="Reinvested" value={rs(sum('reinvestedMinor'))} />
            <Stat label="Still in business" value={rs(sum('retainedMinor'))} sub="All time, to the end date" />
          </div>
          <Table rows={rows} rowKey={(r) => r.personId} empty="No profit or payouts in this period."
            columns={[
              { label: 'Person', render: (r) => (
                <span>{r.name} <span className="text-xs text-[var(--muted)]">{r.role === 'former' ? 'former' : `${r.role} · ${fmtNum(r.sharePercent)}%`}</span></span>) },
              { label: 'Earned', align: 'right', render: (r) => <Money minor={r.earnedMinor} /> },
              { label: 'Taken out', align: 'right', render: (r) => <Money minor={r.withdrawnMinor} /> },
              { label: 'Reinvested', align: 'right', render: (r) => <Money minor={r.reinvestedMinor} /> },
              { label: 'Still in business', align: 'right', render: (r) => <Money minor={r.retainedMinor} className="font-semibold" /> },
            ]} />
          <p className="mt-2 text-xs text-[var(--muted)]">Earned is each person's share of profit, day by day, using the shares in force that day.
            "Still in business" is profit earned so far that was not taken out or reinvested.</p>
        </>
      )}
    </Card>
  );
}

function ProposeShares({ current, onClose }: { current: (Share & { percent: number })[]; onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const inv = useInvalidate();
  const [mode, setMode] = useState<'percent' | 'ratio'>('percent');
  const [rows, setRows] = useState<{ personId: string; weight: string }[]>(() =>
    current.length ? current.map((c) => ({ personId: c.person_id, weight: String(c.percent) })) : [{ personId: '', weight: '' }]);
  const [from, setFrom] = useState(todayPk());
  const [reason, setReason] = useState('');
  const nums = rows.map((r) => Number(r.weight));
  const valid = rows.every((r, i) => r.personId && r.weight.trim() !== '' && nums[i]! > 0);
  const sum = nums.reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);
  const dupes = new Set(rows.map((r) => r.personId)).size !== rows.length;
  const off = mode === 'percent' && Math.abs(sum - 100) > 0.01 * rows.length;
  const submit = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/partners/proposals`, { mode, effectiveFrom: from, reason: reason.trim() || undefined,
      shares: rows.map((r) => ({ personId: r.personId, weight: Number(r.weight) })) }),
    onSuccess: () => { toast('Sent for approval'); inv('partners', 'approvals'); onClose(); },
  });
  const changeMode = (m: 'percent' | 'ratio') => {
    setMode(m);
    if (m === 'percent' && sum > 0) setRows((rs0) => rs0.map((r) => ({ ...r, weight: r.weight ? String(Math.round((Number(r.weight) / sum) * 10000) / 100) : r.weight })));
  };
  return (
    <Modal open onClose={onClose} title="Propose share change" wide footer={
      <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!valid || dupes || off || !from} busy={submit.isPending} onClick={() => submit.mutate()}>
        Send for approval</Button>}>
      <div className="space-y-4">
        <Field label="How do you want to enter shares?">
          <Choice value={mode} onChange={changeMode} options={[{ value: 'percent', label: 'Percent (adds to 100)' }, { value: 'ratio', label: 'Ratio (e.g. 1 : 1 : 2)' }]} />
        </Field>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px_auto] items-center gap-2">
              <PersonSelect value={r.personId} onChange={(v) => setRows((x) => x.map((y, j) => (j === i ? { ...y, personId: v } : y)))} />
              <div className="relative">
                <Input inputMode="decimal" value={r.weight} aria-label="Share" className="pr-7 tabular"
                  onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, weight: e.target.value.replace(/[^\d.]/g, '') } : y)))} />
                {mode === 'percent' && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted)]">%</span>}
              </div>
              <Button variant="ghost" aria-label="Remove" disabled={rows.length === 1} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>✕</Button>
              {mode === 'ratio' && sum > 0 && nums[i]! > 0 && <div className="col-span-3 -mt-1 text-xs text-[var(--muted)]">= {fmtNum((nums[i]! / sum) * 100)}%</div>}
            </div>
          ))}
          <Button size="sm" onClick={() => setRows((x) => [...x, { personId: '', weight: '' }])}>Add person</Button>
        </div>
        {mode === 'percent' && (
          <div className={cx('rounded-xl p-3 text-sm', off ? 'bg-red-600/10 text-[var(--bad)]' : 'bg-green-600/10 text-[var(--good)]')}>
            Total: <b className="tabular">{fmtNum(sum)}%</b>{off ? ` — must add to 100% (${fmtNum(100 - sum)}% ${sum < 100 ? 'missing' : 'too much'}).` : ' ✓'}
          </div>
        )}
        {dupes && <p className="text-sm text-[var(--bad)]">Each person can appear only once.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starts from" hint="Profit from this date is split the new way."><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ali joins as a partner" /></Field>
        </div>
        <p className="text-xs text-[var(--muted)]">Another partner must approve before the new split applies. Old shares are kept in the history.</p>
        <ErrorText error={submit.error} />
      </div>
    </Modal>
  );
}

function InvestorTermsForm({ term, partnerTotal, onClose }: { term: InvestorTerm | null; partnerTotal: number; onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const inv = useInvalidate();
  const [person, setPerson] = useState(term?.person_id ?? '');
  const [takes, setTakes] = useState(term?.takes_return ?? false);
  const [weight, setWeight] = useState(term && Number(term.return_weight) > 0 ? String(Number(term.return_weight)) : '');
  const [mentor, setMentor] = useState(term?.mentorship ?? false);
  const [from, setFrom] = useState(todayPk());
  const w = Number(weight);
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/investors/terms`, { personId: person, takesReturn: takes, returnWeight: takes ? w : 0, mentorship: mentor, effectiveFrom: from }),
    onSuccess: () => { toast('Investor terms saved'); inv('partners'); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="Investor terms" footer={
      <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!person || !from || (takes && !(w > 0))} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="space-y-3">
        <Field label="Investor">{term ? <div className="font-medium">{term.name}</div> : <PersonSelect value={person} onChange={setPerson} />}</Field>
        <Field label="Takes a share of profit?">
          <Choice value={takes ? 'yes' : 'no'} onChange={(v) => setTakes(v === 'yes')} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
        </Field>
        {takes && (
          <Field label="Return share" hint={partnerTotal > 0
            ? `Counted next to the partners' shares (they add up to ${fmtNum(partnerTotal)}).${w > 0 ? ` ${fmtNum(w)} works out to about ${fmtNum((w / (partnerTotal + w)) * 100)}% of profit.` : ''}`
            : 'Counted next to the partners\' shares.'}>
            <Input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^\d.]/g, ''))} className="tabular" />
          </Field>
        )}
        <Field label="Mentorship">
          <Choice value={mentor ? 'on' : 'off'} onChange={(v) => setMentor(v === 'on')} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
        </Field>
        <Field label="Starts from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

// ---------- 3. Capital ----------

type TxnKind = 'investment' | 'loan_in' | 'loan_convert' | 'loan_refund' | 'withdrawal' | 'reinvest' | 'advance' | 'advance_repay';
type TxnStatus = 'pending_approval' | 'awaiting_confirmation' | 'posted' | 'rejected';
interface Txn { id: string; kind: TxnKind; amount_minor: number; status: TxnStatus; reason: string | null; created_at: string; confirmed_at: string | null;
  loan_id: string | null; person_id: string; person_name: string; location_name: string | null; account_name: string | null }
interface Loan { id: string; person_id: string; person_name: string; principal_minor: number; due_date: string | null; status: 'open' | 'closed'; created_at: string;
  note: string | null; location_name: string | null; converted: number; refunded: number; in_progress: number; outstanding: number; available: number }
interface Position { person_id: string; person_name: string; key: 'capital' | 'loans' | 'advances' | 'drawings' | 'reinvested'; location_id: string | null;
  location_name: string | null; balance_minor: number }
interface Capital { txns: Txn[]; loans: Loan[]; positions: Position[] }

const TXN_LABEL: Record<TxnKind, string> = {
  investment: 'Invested', loan_in: 'Lent to business', loan_convert: 'Loan turned into investment', loan_refund: 'Loan paid back',
  withdrawal: 'Payout', reinvest: 'Reinvested profit', advance: 'Borrowed from business', advance_repay: 'Paid back borrowing',
};
const TXN_STATUS: Record<TxnStatus, { label: string; tone: 'warn' | 'good' | 'bad' }> = {
  pending_approval: { label: 'Waiting approval', tone: 'warn' }, awaiting_confirmation: { label: 'Waiting for lender to confirm', tone: 'warn' },
  posted: { label: 'Done', tone: 'good' }, rejected: { label: 'Rejected', tone: 'bad' },
};

function loanWords(l: Loan): { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  if (l.status === 'closed') return { text: 'Closed — fully paid back or turned into investment', tone: 'good' };
  if (l.in_progress > 0) return { text: `${rs(l.in_progress)} being paid back — waiting for approval or for ${l.person_name} to confirm`, tone: 'warn' };
  if (l.due_date && l.due_date < todayPk()) return { text: `Overdue — was due ${dateLabel(l.due_date)}`, tone: 'bad' };
  return { text: `Open — the business still owes ${rs(l.outstanding)}${l.due_date ? `, due ${dateLabel(l.due_date)}` : ''}`, tone: 'neutral' };
}

type CapitalAction = 'investment' | 'loan' | 'withdrawal' | 'reinvest' | 'advance';

function CapitalTab() {
  const { orgId, can, me } = useScope();
  const inv = useInvalidate();
  const toast = useToast();
  const seeAll = can('reports.partners');
  const myId = me.user.personId;
  const q = useQuery({ queryKey: ['capital', orgId, seeAll ? 'all' : myId], queryFn: () => get<Capital>(`/orgs/${orgId}/capital${qs({ personId: seeAll ? undefined : myId })}`),
    enabled: seeAll || !!myId });
  const [action, setAction] = useState<CapitalAction | null>(null);
  const [loanAction, setLoanAction] = useState<{ loan: Loan; kind: 'convert' | 'refund' } | null>(null);
  const [showAllTxns, setShowAllTxns] = useState(false);
  const confirm = useMutation({
    mutationFn: (txnId: string) => post(`/orgs/${orgId}/capital/refunds/${txnId}/confirm`),
    onSuccess: () => { toast('Thanks — marked as received'); inv('capital', 'accounts', 'notifications'); },
    onError: (e) => toast(e.message, 'bad'),
  });
  const people = useMemo(() => groupPositions(q.data?.positions ?? []), [q.data]);

  if (!seeAll && !myId) return <Empty>Only partners can see capital. Your login is not linked to a person.</Empty>;
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorText error={q.error} />;
  const d = q.data;
  const toConfirm = d.txns.filter((t) => t.kind === 'loan_refund' && t.status === 'awaiting_confirmation' && t.person_id === myId);
  const txns = showAllTxns ? d.txns : d.txns.slice(0, 15);
  const actions: { key: CapitalAction; label: string; show: boolean }[] = [
    { key: 'investment', label: 'Record investment', show: can('capital.manage') },
    { key: 'loan', label: 'Record loan', show: can('capital.manage') },
    { key: 'withdrawal', label: 'Request payout', show: can('capital.withdraw') },
    { key: 'reinvest', label: 'Reinvest profit', show: can('capital.manage') },
    { key: 'advance', label: 'Borrowing', show: can('capital.manage') },
  ];

  return (
    <div className="space-y-4">
      {toConfirm.map((t) => (
        <div key={t.id} className="rounded-2xl border-2 border-brand bg-brand/15 p-4">
          <div className="text-lg font-bold">Did you receive {rs(t.amount_minor)}?</div>
          <p className="mt-1 text-sm">The business paid back part of your loan{t.account_name ? ` from ${t.account_name}` : ''}. It only counts as paid once you confirm the money reached you.</p>
          <Button variant="primary" size="lg" className="mt-3 w-full sm:w-auto" busy={confirm.isPending && confirm.variables === t.id} onClick={() => confirm.mutate(t.id)}>
            Confirm I received it</Button>
        </div>
      ))}
      {!seeAll && <p className="text-sm text-[var(--muted)]">You are seeing your own capital only.</p>}

      {actions.some((a) => a.show) && (
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {actions.filter((a) => a.show).map((a, i) => (
            <Button key={a.key} variant={i === 0 ? 'primary' : 'secondary'} size="lg" onClick={() => setAction(a.key)}>{a.label}</Button>
          ))}
        </div>
      )}

      <Card title="Where everyone stands">
        {people.length === 0 ? <Empty>No capital recorded yet.</Empty> : (
          <div className="grid gap-3 lg:grid-cols-2">
            {people.map((p) => (
              <div key={p.id} className="rounded-xl border border-[var(--line)] p-3">
                <div className="font-semibold">{p.name}</div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <PosLine label="Invested" minor={p.capital} strong />
                  <PosLine label="Lent to business" minor={p.loans} />
                  <PosLine label="Taken out" minor={p.drawings} />
                  <PosLine label="Reinvested" minor={p.reinvested} />
                  <PosLine label="Owes the business" minor={p.advances} warn={p.advances > 0} />
                </dl>
                {p.capitalBy.length > 1 && (
                  <div className="mt-2 border-t border-[var(--line)] pt-2 text-xs text-[var(--muted)]">
                    {p.capitalBy.map((c) => <div key={c.name} className="flex justify-between"><span>{c.name}</span><span className="tabular">{rs(c.minor)}</span></div>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-[var(--muted)]">Invested includes reinvested profit and loans turned into investment. Capital is kept separate from profit.</p>
      </Card>

      <Card title="Loans to the business">
        {d.loans.length === 0 ? <p className="text-sm text-[var(--muted)]">No loans.</p> : (
          <ul className="space-y-2">
            {d.loans.map((l) => {
              const w = loanWords(l);
              return (
                <li key={l.id} className="rounded-xl border border-[var(--line)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">{l.person_name} lent <Money minor={l.principal_minor} /></div>
                      <div className="text-sm text-[var(--muted)]">{dateLabel(l.created_at)}{l.location_name ? ` · ${l.location_name}` : ''}{l.note ? ` · ${l.note}` : ''}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-[var(--muted)]">Still owed</div>
                      <Money minor={l.outstanding} className="text-lg font-bold" />
                    </div>
                  </div>
                  <div className="mt-2"><Badge tone={w.tone}>{w.text}</Badge></div>
                  {(l.converted > 0 || l.refunded > 0) && (
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      {l.refunded > 0 ? `Paid back ${rs(l.refunded)}. ` : ''}{l.converted > 0 ? `Turned into investment ${rs(l.converted)}.` : ''}
                    </div>
                  )}
                  {can('capital.manage') && l.status === 'open' && l.available > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => setLoanAction({ loan: l, kind: 'refund' })}>Pay back</Button>
                      <Button size="sm" onClick={() => setLoanAction({ loan: l, kind: 'convert' })}>Turn into investment</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer py-2 font-medium">What do loan statuses mean?</summary>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--muted)]">
            <li><b>Open</b> — the business still owes this money to the lender.</li>
            <li><b>Waiting approval</b> — someone asked to pay part back; a partner must approve first.</li>
            <li><b>Waiting for lender to confirm</b> — approved and paid out. It is not counted as paid until the lender taps "Confirm I received it".</li>
            <li><b>Turned into investment</b> — the loan money was spent on the business, so it now counts as the lender's investment.</li>
            <li><b>Closed</b> — nothing is owed any more.</li>
          </ul>
        </details>
      </Card>

      <Card title="Capital movements">
        <Table rows={txns} rowKey={(r) => r.id} empty="Nothing recorded yet."
          columns={[
            { label: 'When', render: (r) => timeLabel(r.created_at) },
            { label: 'Person', render: (r) => r.person_name },
            { label: 'What', render: (r) => TXN_LABEL[r.kind] },
            { label: 'Amount', align: 'right', render: (r) => <Money minor={r.amount_minor} className="font-semibold" /> },
            { label: 'Account', render: (r) => r.account_name ?? '—', hideOnMobile: true },
            { label: 'Stall', render: (r) => r.location_name ?? 'Whole business', hideOnMobile: true },
            { label: 'Status', render: (r) => <Badge tone={TXN_STATUS[r.status].tone}>{TXN_STATUS[r.status].label}</Badge> },
            { label: 'Reason', render: (r) => r.reason ?? '', hideOnMobile: true },
          ]} />
        {d.txns.length > 15 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setShowAllTxns((v) => !v)}>{showAllTxns ? 'Show fewer' : `Show all ${d.txns.length}`}</Button>}
      </Card>

      {action && <CapitalForm action={action} onClose={() => setAction(null)} />}
      {loanAction && <LoanActionForm loan={loanAction.loan} kind={loanAction.kind} onClose={() => setLoanAction(null)} />}
    </div>
  );
}

function PosLine({ label, minor, strong, warn }: { label: string; minor: number; strong?: boolean; warn?: boolean }) {
  return (
    <>
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className={cx('text-right tabular', strong && 'font-bold', warn && 'text-[var(--warn)]')}>{minor ? rs(minor) : '—'}</dd>
    </>
  );
}

function groupPositions(rows: Position[]) {
  const map = new Map<string, { id: string; name: string; capital: number; loans: number; advances: number; drawings: number; reinvested: number;
    capitalBy: { name: string; minor: number }[] }>();
  for (const r of rows) {
    const p = map.get(r.person_id) ?? { id: r.person_id, name: r.person_name, capital: 0, loans: 0, advances: 0, drawings: 0, reinvested: 0, capitalBy: [] };
    // Balances are credit - debit: capital and loans are owed to the person (positive);
    // advances, drawings and reinvested are debit balances, so flip their sign for display.
    if (r.key === 'capital') {
      p.capital += r.balance_minor;
      if (r.balance_minor !== 0) p.capitalBy.push({ name: r.location_name ?? 'Whole business', minor: r.balance_minor });
    } else if (r.key === 'loans') p.loans += r.balance_minor;
    else p[r.key] -= r.balance_minor;
    map.set(r.person_id, p);
  }
  return [...map.values()];
}

function CapitalForm({ action, onClose }: { action: CapitalAction; onClose: () => void }) {
  const { orgId, location } = useScope();
  const toast = useToast();
  const inv = useInvalidate();
  const [person, setPerson] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [account, setAccount] = useState('');
  const [loc, setLoc] = useState(action === 'withdrawal' || action === 'advance' ? '' : location?.id ?? '');
  const [due, setDue] = useState('');
  const [direction, setDirection] = useState<'take' | 'repay'>('take');
  const [reason, setReason] = useState('');
  const meta: Record<CapitalAction, { title: string; button: string; account?: string; loc?: boolean; note?: string }> = {
    investment: { title: 'Record investment', button: 'Record investment', account: 'Paid into', loc: true },
    loan: { title: 'Record loan', button: 'Record loan', account: 'Paid into', loc: true, note: 'A loan is money the business must pay back. It is not investment.' },
    withdrawal: { title: 'Request payout', button: 'Send for approval', account: 'Paid from', loc: true,
      note: 'A payout needs a partner\'s approval. Every partner is told once it is paid.' },
    reinvest: { title: 'Reinvest profit', button: 'Reinvest', loc: true, note: 'Keeps this person\'s profit share in the business as investment instead of taking it out.' },
    advance: { title: 'Borrowing', button: direction === 'take' ? 'Record borrowing' : 'Record repayment', account: direction === 'take' ? 'Taken from' : 'Paid into',
      note: 'When someone borrows money from the business, it is tracked against their name until paid back.' },
  };
  const m = meta[action];
  const body = { personId: person, amountMinor: amount, reason: reason.trim() || undefined };
  const save = useMutation({
    mutationFn: () => {
      const base = `/orgs/${orgId}/capital`;
      switch (action) {
        case 'investment': return post(`${base}/investments`, { ...body, moneyAccountId: account, locationId: loc || null });
        case 'loan': return post(`${base}/loans`, { ...body, moneyAccountId: account, locationId: loc || null, dueDate: due || null });
        case 'withdrawal': return post(`${base}/withdrawals`, { ...body, moneyAccountId: account, locationId: loc || null });
        case 'reinvest': return post(`${base}/reinvest`, { ...body, locationId: loc || null });
        case 'advance': return post(`${base}/advances`, { ...body, moneyAccountId: account, direction });
      }
    },
    onSuccess: () => { toast(action === 'withdrawal' ? 'Payout sent for approval' : 'Saved'); inv('capital', 'accounts', 'partners', 'approvals'); onClose(); },
  });
  const ready = person && amount && (!m.account || account);
  return (
    <Modal open onClose={onClose} title={m.title} footer={
      <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!ready} busy={save.isPending} onClick={() => save.mutate()}>{m.button}</Button>}>
      <div className="space-y-3">
        {m.note && <p className="rounded-xl bg-[var(--panel-2)] p-3 text-sm">{m.note}</p>}
        {action === 'advance' && (
          <Choice value={direction} onChange={setDirection} options={[{ value: 'take', label: 'Takes money' }, { value: 'repay', label: 'Pays it back' }]} />
        )}
        <Field label={action === 'withdrawal' ? 'Paid to' : action === 'loan' ? 'Lender' : 'Person'}><PersonSelect value={person} onChange={setPerson} /></Field>
        <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} /></Field>
        {m.account && <Field label={m.account}><AccountSelect value={account} onChange={setAccount} showBalance /></Field>}
        {m.loc && <Field label="For which stall?" hint="Leave empty to count it for the whole business."><LocationSelect value={loc} onChange={setLoc} /></Field>}
        {action === 'loan' && <Field label="Due date (optional)"><Input type="date" value={due} min={todayPk()} onChange={(e) => setDue(e.target.value)} /></Field>}
        <Field label="Reason / note"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

function LoanActionForm({ loan, kind, onClose }: { loan: Loan; kind: 'convert' | 'refund'; onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const inv = useInvalidate();
  const [amount, setAmount] = useState<number | null>(loan.available);
  const [account, setAccount] = useState('');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => kind === 'convert'
      ? post(`/orgs/${orgId}/capital/loans/${loan.id}/convert`, { amountMinor: amount, reason: reason.trim() })
      : post(`/orgs/${orgId}/capital/loans/${loan.id}/refund`, { amountMinor: amount, moneyAccountId: account, reason: reason.trim() || undefined }),
    onSuccess: () => { toast(kind === 'convert' ? 'Turned into investment' : 'Pay-back sent for approval'); inv('capital', 'approvals'); onClose(); },
  });
  const over = amount != null && amount > loan.available;
  const ready = amount && !over && (kind === 'convert' ? reason.trim().length >= 2 : !!account);
  return (
    <Modal open onClose={onClose} title={kind === 'convert' ? 'Turn loan into investment' : 'Pay back loan'} footer={
      <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!ready} busy={save.isPending} onClick={() => save.mutate()}>
        {kind === 'convert' ? 'Turn into investment' : 'Send for approval'}</Button>}>
      <div className="space-y-3">
        <p className="text-sm">{loan.person_name} lent {rs(loan.principal_minor)}. <b>{rs(loan.available)}</b> can still be {kind === 'convert' ? 'turned into investment' : 'paid back'}.</p>
        {kind === 'refund' && (
          <p className="rounded-xl bg-[var(--panel-2)] p-3 text-sm">After a partner approves, {loan.person_name} must confirm they received the money. Only then is it counted as paid.</p>
        )}
        <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} /></Field>
        {over && <p className="text-sm text-[var(--bad)]">Only {rs(loan.available)} is open on this loan.</p>}
        {kind === 'refund' && <Field label="Paid from"><AccountSelect value={account} onChange={setAccount} showBalance /></Field>}
        <Field label={kind === 'convert' ? 'Why? (required)' : 'Note'} hint={kind === 'convert' ? 'e.g. spent on the fryer and stall setup' : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

// ---------- 4. Staff & wages ----------

type PayType = 'monthly' | 'daily' | 'hourly' | 'none';
interface Employee {
  id: string; person_id: string; name: string; phone: string | null; location_id: string | null; location_name: string | null; title: string;
  pay_type: PayType; pay_rate_minor: number; commission_enabled: boolean; commission_bps: number; active: boolean; started_on: string | null;
  ended_on: string | null; commission_owed_minor: number;
}
interface Wage { id: string; employee_id: string; name: string; period_from: string | null; period_to: string | null; units: string; base_minor: number;
  commission_minor: number; total_minor: number; account_name: string; created_at: string; note: string | null }

const PAY_LABEL: Record<PayType, string> = { monthly: 'Monthly salary', daily: 'Daily pay', hourly: 'Hourly pay', none: 'No fixed pay' };
const RATE_LABEL: Record<PayType, string> = { monthly: 'Salary per month', daily: 'Pay per day', hourly: 'Pay per hour', none: '' };
const UNIT: Record<PayType, string> = { monthly: 'months', daily: 'days', hourly: 'hours', none: '' };
const PER: Record<PayType, string> = { monthly: '/month', daily: '/day', hourly: '/hour', none: '' };

function StaffTab() {
  const { orgId } = useScope();
  const emps = useQuery({ queryKey: ['employees', orgId], queryFn: () => get<Employee[]>(`/orgs/${orgId}/employees`) });
  const wages = useQuery({ queryKey: ['wages', orgId], queryFn: () => get<Wage[]>(`/orgs/${orgId}/wages`) });
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const [paying, setPaying] = useState<Employee | null>(null);
  const list = emps.data ?? [];
  const owed = list.reduce((a, e) => a + e.commission_owed_minor, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Stat label="Staff" value={list.filter((e) => e.active).length} sub={`${list.length - list.filter((e) => e.active).length} not active`} />
        <Stat label="Commission owed" value={rs(owed)} />
        <Button variant="primary" size="lg" onClick={() => setEditing('new')}>Add employee</Button>
      </div>
      <Card title="Employees">
        <ErrorText error={emps.error} />
        {emps.isLoading ? <Loading /> : (
          <Table rows={list} rowKey={(r) => r.id} empty="No employees yet." onRowClick={(r) => setEditing(r)}
            columns={[
              { label: 'Name', render: (r) => (
                <span className={cx(!r.active && 'opacity-60')}>
                  <span className="font-medium">{r.name}</span> <span className="text-xs text-[var(--muted)]">{r.title}</span>
                  {!r.active && <> <Badge>Not active</Badge></>}
                </span>) },
              { label: 'Stall', render: (r) => r.location_name ?? 'All', hideOnMobile: true },
              { label: 'Pay', render: (r) => (r.pay_type === 'none' ? 'No fixed pay' : `${rs(r.pay_rate_minor)}${PER[r.pay_type]}`) },
              { label: 'Commission', render: (r) => (r.commission_enabled ? `${fmtNum(r.commission_bps / 100)}% of sales` : 'Off') },
              { label: 'Owed', align: 'right', render: (r) => <Money minor={r.commission_owed_minor} /> },
              { label: '', render: (r) => (
                <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); setPaying(r); }}>Pay</Button>) },
            ]} />
        )}
      </Card>
      <Card title="Wages paid">
        <ErrorText error={wages.error} />
        {wages.isLoading ? <Loading /> : (
          <Table rows={wages.data ?? []} rowKey={(r) => r.id} empty="No wages paid yet."
            columns={[
              { label: 'Paid', render: (r) => timeLabel(r.created_at) },
              { label: 'Person', render: (r) => r.name },
              { label: 'Period', render: (r) => (r.period_from || r.period_to ? `${dateLabel(r.period_from)} – ${dateLabel(r.period_to)}` : '—'), hideOnMobile: true },
              { label: 'Base', align: 'right', render: (r) => <Money minor={r.base_minor} />, hideOnMobile: true },
              { label: 'Commission', align: 'right', render: (r) => <Money minor={r.commission_minor} />, hideOnMobile: true },
              { label: 'Total', align: 'right', render: (r) => <Money minor={r.total_minor} className="font-semibold" /> },
              { label: 'From', render: (r) => r.account_name },
            ]} />
        )}
      </Card>
      {editing && <EmployeeForm emp={editing === 'new' ? null : editing} taken={list.map((e) => e.person_id)} onClose={() => setEditing(null)} />}
      {paying && <PayWages emp={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}

function EmployeeForm({ emp, taken, onClose }: { emp: Employee | null; taken: string[]; onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const inv = useInvalidate();
  const [person, setPerson] = useState(emp?.person_id ?? '');
  const [title, setTitle] = useState(emp?.title ?? '');
  const [loc, setLoc] = useState(emp?.location_id ?? '');
  const [payType, setPayType] = useState<PayType>(emp?.pay_type ?? 'monthly');
  const [rate, setRate] = useState<number | null>(emp ? emp.pay_rate_minor : null);
  const [commOn, setCommOn] = useState(emp?.commission_enabled ?? false);
  const [commPct, setCommPct] = useState(emp && emp.commission_bps ? String(emp.commission_bps / 100) : '');
  const [active, setActive] = useState(emp?.active ?? true);
  const [started, setStarted] = useState(emp?.started_on ?? '');
  const [ended, setEnded] = useState(emp?.ended_on ?? '');
  const pct = Number(commPct || '0');
  const pctOk = !commOn || (/^\d+(\.\d{1,2})?$/.test(commPct) && pct > 0 && pct <= 100);
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/employees`, {
      id: emp?.id, personId: person, locationId: loc || null, title: title.trim(), payType, payRateMinor: payType === 'none' ? 0 : rate ?? 0,
      commissionEnabled: commOn, commissionBps: commOn ? Math.round(pct * 100) : 0, active, startedOn: started || null, endedOn: ended || null,
    }),
    onSuccess: () => { toast(emp ? 'Employee saved' : 'Employee added'); inv('employees'); onClose(); },
  });
  const ready = person && title.trim().length >= 2 && (payType === 'none' || rate != null) && pctOk;
  return (
    <Modal open onClose={onClose} title={emp ? `Edit ${emp.name}` : 'Add employee'} footer={
      <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!ready} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="space-y-3">
        {!emp && (
          <Field label="Person" hint={<>Not in the list? Add them first in <Link to="/admin" className="underline">Admin</Link>.</>}>
            <PersonSelect value={person} onChange={setPerson} filter={(p) => !taken.includes(p.id)} />
          </Field>
        )}
        <Field label="Job title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Fry cook, Cashier" /></Field>
        <Field label="Stall"><LocationSelect value={loc} onChange={setLoc} placeholder="All stalls" /></Field>
        <Field label="How are they paid?">
          <Select value={payType} onChange={(e) => setPayType(e.target.value as PayType)}
            options={(Object.keys(PAY_LABEL) as PayType[]).map((k) => ({ value: k, label: PAY_LABEL[k] }))} />
        </Field>
        {payType !== 'none' && <Field label={RATE_LABEL[payType]}><MoneyInput value={rate} onChange={setRate} /></Field>}
        <Field label="Sales commission" hint="Off by default (for example, partners do not take commission).">
          <Choice value={commOn ? 'on' : 'off'} onChange={(v) => setCommOn(v === 'on')} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
        </Field>
        {commOn && (
          <Field label="Commission percent" hint={pctOk ? undefined : 'Between 0.01% and 100%, up to 2 decimals.'}>
            <div className="relative">
              <Input inputMode="decimal" value={commPct} onChange={(e) => setCommPct(e.target.value.replace(/[^\d.]/g, ''))} className="pr-8 tabular" placeholder="e.g. 2.5" />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted)]">%</span>
            </div>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Started on"><Input type="date" value={started} onChange={(e) => setStarted(e.target.value)} /></Field>
          {emp && <Field label="Left on"><Input type="date" value={ended} onChange={(e) => setEnded(e.target.value)} /></Field>}
        </div>
        {emp && (
          <Field label="Status">
            <Choice value={active ? 'on' : 'off'} onChange={(v) => setActive(v === 'on')} options={[{ value: 'on', label: 'Working' }, { value: 'off', label: 'Not active' }]} />
          </Field>
        )}
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

function PayWages({ emp, onClose }: { emp: Employee; onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const inv = useInvalidate();
  const [units, setUnits] = useState(emp.pay_type === 'monthly' ? '1' : '');
  const [comm, setComm] = useState<number | null>(emp.commission_owed_minor > 0 ? emp.commission_owed_minor : 0);
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState(emp.pay_type === 'monthly' ? monthStart() : '');
  const [to, setTo] = useState(emp.pay_type === 'monthly' ? todayPk() : '');
  const [note, setNote] = useState('');
  const unitsOk = emp.pay_type === 'none' || units === '' || /^\d+(\.\d{1,3})?$/.test(units);
  const base = emp.pay_type === 'none' || !unitsOk ? 0 : Math.round(emp.pay_rate_minor * Number(units || '0'));
  const commOver = (comm ?? 0) > emp.commission_owed_minor;
  const total = base + (comm ?? 0);
  const pay = useMutation({
    mutationFn: () => post<{ totalMinor: number }>(`/orgs/${orgId}/wages`, {
      employeeId: emp.id, units: emp.pay_type === 'none' ? '0' : units || '0', commissionMinor: comm ?? 0, moneyAccountId: account,
      periodFrom: from || null, periodTo: to || null, note: note.trim() || undefined,
    }),
    onSuccess: (r) => { toast(`Paid ${rs(r.totalMinor)} to ${emp.name}`); inv('employees', 'wages', 'accounts'); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={`Pay ${emp.name}`} footer={
      <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!unitsOk || commOver || total <= 0 || !account} busy={pay.isPending} onClick={() => pay.mutate()}>
        Pay {rs(total)}</Button>}>
      <div className="space-y-3">
        <p className="text-sm text-[var(--muted)]">{emp.title} · {emp.pay_type === 'none' ? 'no fixed pay' : `${rs(emp.pay_rate_minor)}${PER[emp.pay_type]}`}</p>
        {emp.pay_type !== 'none' && (
          <Field label={`How many ${UNIT[emp.pay_type]}?`} hint={unitsOk ? `${units || 0} × ${rs(emp.pay_rate_minor)} = ${rs(base)}` : 'Use a number, up to 3 decimals.'}>
            <Input inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value.replace(/[^\d.]/g, ''))} className="tabular" autoFocus />
          </Field>
        )}
        <Field label="Commission to pay" hint={<>Owed so far: <b>{rs(emp.commission_owed_minor)}</b>
          {emp.commission_owed_minor > 0 && comm !== emp.commission_owed_minor && (
            <> · <button type="button" className="underline" onClick={() => setComm(emp.commission_owed_minor)}>pay all</button></>)}</>}>
          <MoneyInput value={comm} onChange={setComm} disabled={emp.commission_owed_minor === 0} />
        </Field>
        {commOver && <p className="text-sm text-[var(--bad)]">Only {rs(emp.commission_owed_minor)} commission is owed.</p>}
        <Field label="Paid from"><AccountSelect value={account} onChange={setAccount} showBalance /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Period from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Period to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex items-baseline justify-between rounded-xl bg-[var(--panel-2)] p-3">
          <span className="text-sm">Base {rs(base)} + commission {rs(comm ?? 0)}</span>
          <span className="text-2xl font-bold tabular">{rs(total)}</span>
        </div>
        <ErrorText error={pay.error} />
      </div>
    </Modal>
  );
}

// Keep ReactNode import used for helper prop types above.
export type { ReactNode };
