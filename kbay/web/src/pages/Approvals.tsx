import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, qs } from '../api';
import { Badge, Button, cx, Empty, ErrorText, Field, Loading, Modal, Money, PageHeader, Select, Tabs, Textarea, useToast } from '../components/ui';
import { timeLabel } from '../format';
import { useScope } from '../session';

type Status = 'pending' | 'approved' | 'rejected' | 'cancelled';
interface Approval {
  id: string; kind: string; subject_type: string; subject_id: string; summary: string; amount_minor: number | null; status: Status;
  location_id: string | null; location_name: string | null; requested_by: string; requested_by_name: string; requested_at: string;
  decided_at: string | null; decision_note: string | null; decided_by_name: string | null; comment_count: number; canDecide: boolean;
  detail?: SubjectDetail | null;
}
interface Comment {
  id: string; parent_id: string | null; body: string; is_question: boolean; asked_user_id: string | null; answered_at: string | null;
  created_at: string; author_id: string; author_name: string; asked_name: string | null;
}
interface Person { id: string; full_name: string; display_name: string | null; user_id: string | null }

const KIND: Record<string, string> = {
  expense: 'Expense', purchase: 'Purchase', supplier_credit: 'Supplier credit', day_close: 'Daily close', withdrawal: 'Payout',
  refund: 'Refund', loan_refund: 'Loan refund', partner_change: 'Partner change',
};
const STATUS: Record<Status, { label: string; tone: 'warn' | 'good' | 'bad' | 'neutral' }> = {
  pending: { label: 'Waiting', tone: 'warn' }, approved: { label: 'Approved', tone: 'good' }, rejected: { label: 'Rejected', tone: 'bad' },
  cancelled: { label: 'Withdrawn', tone: 'neutral' },
};
type Filter = 'pending' | 'approved' | 'rejected' | 'all';

export function Approvals() {
  const { orgId } = useScope();
  const { id } = useParams();
  const nav = useNavigate();
  const [filter, setFilter] = useState<Filter>('pending');
  const list = useQuery({ queryKey: ['approvals', orgId, filter], queryFn: () => get<Approval[]>(`/orgs/${orgId}/approvals${qs({ status: filter })}`),
    refetchInterval: 30_000 });
  // Full request with what is behind it (expense, purchase lines, close figures...).
  const one = useQuery({ queryKey: ['approval', orgId, id], queryFn: () => get<Approval>(`/orgs/${orgId}/approvals/${id}`), enabled: !!id });
  const detail = one.data ?? list.data?.find((a) => a.id === id);
  const [rejecting, setRejecting] = useState<Approval | null>(null);
  const rows = list.data ?? [];
  const toDecide = rows.filter((r) => r.canDecide && r.status === 'pending').length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Approvals" sub={filter === 'pending' ? (toDecide > 0 ? `${toDecide} waiting for you` : 'Nothing waiting for you') : undefined} />
      <Tabs value={filter} onChange={setFilter} tabs={[
        { value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' },
      ]} />
      <ErrorText error={list.error} />
      {list.isLoading ? <Loading /> : rows.length === 0 ? (
        <Empty>{filter === 'pending' ? 'No requests are waiting.' : 'Nothing here.'}</Empty>
      ) : (
        <ul className="space-y-3">
          {rows.map((a) => <Row key={a.id} a={a} onOpen={() => nav(`/approvals/${a.id}`)} onReject={() => setRejecting(a)} />)}
        </ul>
      )}
      {id && (
        <Modal open onClose={() => nav('/approvals')} title={detail ? KIND[detail.kind] ?? 'Request' : 'Request'} wide>
          {detail ? <Detail a={detail} onReject={() => setRejecting(detail)} onDone={() => nav('/approvals')} />
            : one.isLoading ? <Loading /> : <Empty>This request was not found.</Empty>}
        </Modal>
      )}
      {rejecting && <RejectSheet a={rejecting} onClose={() => setRejecting(null)} />}
    </div>
  );
}

function useDecide() {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject'; note?: string }) =>
      post(`/orgs/${orgId}/approvals/${v.id}/decide`, { decision: v.decision, note: v.note || undefined }),
    onSuccess: (_d, v) => {
      toast(v.decision === 'approve' ? 'Approved' : 'Rejected');
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['comments'] });
    },
    onError: (e) => toast(e.message, 'bad'),
  });
}

function Meta({ a }: { a: Approval }) {
  return (
    <span className="text-sm text-[var(--muted)]">
      {a.requested_by_name} · {timeLabel(a.requested_at)}{a.location_name ? ` · ${a.location_name}` : ''}
    </span>
  );
}

function Row({ a, onOpen, onReject }: { a: Approval; onOpen: () => void; onReject: () => void }) {
  const decide = useDecide();
  const st = STATUS[a.status];
  const busy = decide.isPending && decide.variables?.id === a.id;
  return (
    <li className={cx('rounded-2xl border bg-[var(--panel)]', a.canDecide && a.status === 'pending' ? 'border-brand/60' : 'border-[var(--line)]')}>
      <button onClick={onOpen} className="block w-full rounded-2xl p-4 text-left active:bg-[var(--panel-2)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="brand">{KIND[a.kind] ?? a.kind}</Badge>
              <Badge tone={st.tone}>{st.label}</Badge>
              {a.comment_count > 0 && <span className="text-xs text-[var(--muted)]">💬 {a.comment_count}</span>}
            </div>
            <div className="mt-2 font-medium leading-snug">{a.summary}</div>
            <div className="mt-1"><Meta a={a} /></div>
          </div>
          {a.amount_minor != null && <Money minor={a.amount_minor} className="shrink-0 text-lg font-bold" />}
        </div>
      </button>
      {a.canDecide && a.status === 'pending' && (
        <div className="grid grid-cols-2 gap-2 border-t border-[var(--line)] p-3">
          <Button variant="good" size="lg" busy={busy && decide.variables?.decision === 'approve'} disabled={busy}
            onClick={() => decide.mutate({ id: a.id, decision: 'approve' })}>Approve</Button>
          <Button size="lg" disabled={busy} onClick={onReject}>Reject</Button>
        </div>
      )}
    </li>
  );
}

function RejectSheet({ a, onClose }: { a: Approval; onClose: () => void }) {
  const decide = useDecide();
  const [note, setNote] = useState('');
  return (
    <Modal open onClose={onClose} title="Reject request" footer={
      <Button variant="danger" size="lg" className="w-full sm:w-auto" disabled={note.trim().length < 2} busy={decide.isPending}
        onClick={() => decide.mutate({ id: a.id, decision: 'reject', note: note.trim() }, { onSuccess: onClose })}>Reject</Button>}>
      <p className="mb-3 text-sm">{a.summary}</p>
      <Field label="Why? (required)" hint="The person who asked will see this.">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="e.g. receipt missing, please attach" />
      </Field>
      <ErrorText error={decide.error} />
    </Modal>
  );
}

function Detail({ a, onReject, onDone }: { a: Approval; onReject: () => void; onDone: () => void }) {
  const { orgId, me } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const decide = useDecide();
  const [note, setNote] = useState('');
  const cancel = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/approvals/${a.id}/cancel`),
    onSuccess: () => { toast('Request withdrawn'); void qc.invalidateQueries({ queryKey: ['approvals'] }); onDone(); },
  });
  const st = STATUS[a.status];
  const mine = a.requested_by === me.user.userId;
  const pending = a.status === 'pending';
  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2"><Badge tone={st.tone}>{st.label}</Badge><Badge tone="brand">{KIND[a.kind] ?? a.kind}</Badge></div>
        <p className="mt-2 text-lg font-semibold leading-snug">{a.summary}</p>
        {a.amount_minor != null && <Money minor={a.amount_minor} className="mt-1 block text-3xl font-bold" />}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-[var(--panel-2)] p-3 text-sm">
        <dt className="text-[var(--muted)]">Asked by</dt><dd>{a.requested_by_name}{mine ? ' (you)' : ''}</dd>
        <dt className="text-[var(--muted)]">When</dt><dd>{timeLabel(a.requested_at)}</dd>
        <dt className="text-[var(--muted)]">Where</dt><dd>{a.location_name ?? 'Whole business'}</dd>
        {a.decided_at && <><dt className="text-[var(--muted)]">{a.status === 'cancelled' ? 'Withdrawn' : 'Decided'}</dt>
          <dd>{timeLabel(a.decided_at)}{a.decided_by_name ? ` by ${a.decided_by_name}` : ''}</dd></>}
        {a.decision_note && <><dt className="text-[var(--muted)]">Note</dt><dd>{a.decision_note}</dd></>}
      </dl>
      {a.detail ? <Subject d={a.detail} /> : null}
      {pending && a.canDecide && (
        <div className="space-y-2">
          <Field label="Note (optional for approve, required to reject)">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="good" size="lg" busy={decide.isPending && decide.variables?.decision === 'approve'} disabled={decide.isPending}
              onClick={() => decide.mutate({ id: a.id, decision: 'approve', note: note.trim() }, { onSuccess: onDone })}>Approve</Button>
            <Button size="lg" disabled={decide.isPending} busy={decide.isPending && decide.variables?.decision === 'reject'}
              onClick={() => (note.trim().length >= 2 ? decide.mutate({ id: a.id, decision: 'reject', note: note.trim() }, { onSuccess: onDone }) : onReject())}>
              Reject
            </Button>
          </div>
        </div>
      )}
      {pending && mine && (
        <div className="rounded-xl border border-[var(--line)] p-3">
          <p className="mb-2 text-sm text-[var(--muted)]">Made a mistake? You can withdraw this request while it is still waiting.</p>
          <Button variant="danger" busy={cancel.isPending} onClick={() => { if (confirm('Withdraw this request?')) cancel.mutate(); }}>Withdraw request</Button>
          <ErrorText error={cancel.error} />
        </div>
      )}
      <Thread approvalId={a.id} />
    </div>
  );
}

function Thread({ approvalId }: { approvalId: string }) {
  const { orgId, me, can } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const comments = useQuery({ queryKey: ['comments', 'approval', approvalId],
    queryFn: () => get<Comment[]>(`/orgs/${orgId}/comments${qs({ entityType: 'approval', entityId: approvalId })}`) });
  const people = useQuery({ queryKey: ['people', orgId], queryFn: () => get<Person[]>(`/orgs/${orgId}/people`) });
  const users = (people.data ?? []).filter((p) => p.user_id && p.user_id !== me.user.userId);
  const [body, setBody] = useState('');
  const [ask, setAsk] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const add = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/comments`, {
      entityType: 'approval', entityId: approvalId, body: body.trim(), parentId: replyTo?.id ?? null,
      askUserId: replyTo ? null : ask || null, link: `/approvals/${approvalId}`,
    }),
    onSuccess: () => {
      toast(ask && !replyTo ? 'Question sent' : 'Note added');
      setBody(''); setAsk(''); setReplyTo(null);
      void qc.invalidateQueries({ queryKey: ['comments', 'approval', approvalId] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
  const all = comments.data ?? [];
  const top = all.filter((c) => !c.parent_id || !all.some((p) => p.id === c.parent_id));
  const replies = (id: string) => all.filter((c) => c.parent_id === id);

  return (
    <section>
      <h3 className="mb-2 font-semibold">Notes and questions</h3>
      {comments.isLoading ? <Loading /> : top.length === 0 ? <p className="text-sm text-[var(--muted)]">No notes yet.</p> : (
        <ul className="space-y-3">
          {top.map((c) => {
            const waitingOnMe = c.is_question && !c.answered_at && c.asked_user_id === me.user.userId;
            return (
              <li key={c.id} className={cx('rounded-xl border p-3', waitingOnMe ? 'border-brand bg-brand/10' : 'border-[var(--line)]')}>
                <CommentBody c={c} />
                {replies(c.id).map((r) => (
                  <div key={r.id} className="ml-3 mt-2 border-l-2 border-[var(--line)] pl-3"><CommentBody c={r} /></div>
                ))}
                {can('comment.create') && (
                  <button className="mt-2 h-9 text-sm font-medium underline" onClick={() => { setReplyTo(c); setAsk(''); }}>
                    {waitingOnMe ? 'Answer' : 'Reply'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {can('comment.create') && (
        <div className="mt-4 space-y-2 rounded-xl bg-[var(--panel-2)] p-3">
          {replyTo && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">Replying to <b>{replyTo.author_name}</b>: {replyTo.body}</span>
              <button className="h-9 shrink-0 px-2 underline" onClick={() => setReplyTo(null)}>Cancel</button>
            </div>
          )}
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={replyTo ? 'Your reply' : ask ? 'Your question' : 'Write a note'} aria-label="Message" />
          <div className="flex flex-wrap items-center gap-2">
            {!replyTo && (
              <Select className="min-w-0 flex-1 sm:max-w-64" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Just a note (no question)"
                aria-label="Ask a person" options={users.map((p) => ({ value: p.user_id!, label: `Ask ${p.display_name ?? p.full_name}` }))} />
            )}
            <Button variant="primary" disabled={!body.trim()} busy={add.isPending} onClick={() => add.mutate()} className="ml-auto">
              {replyTo ? 'Send reply' : ask ? 'Ask' : 'Add note'}
            </Button>
          </div>
          <ErrorText error={add.error} />
        </div>
      )}
    </section>
  );
}

function CommentBody({ c }: { c: Comment }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
        <span className="font-semibold text-[var(--ink)]">{c.author_name}</span>
        <span>{timeLabel(c.created_at)}</span>
        {c.is_question && <Badge tone={c.answered_at ? 'good' : 'warn'}>{c.answered_at ? 'Answered' : `Question for ${c.asked_name ?? 'someone'}`}</Badge>}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
    </div>
  );
}

// ---- What is behind the request ----
type SubjectDetail = Record<string, unknown> & { type: string };
const n = (v: unknown) => Number(v ?? 0);

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-[var(--muted)]">{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

function Subject({ d }: { d: SubjectDetail }) {
  const box = 'rounded-xl border border-[var(--line)] p-3';
  if (d.type === 'expense') {
    return <div className={box}><Rows rows={[
      ['Category', String(d.category)], ['For', String(d.description)], ['Payee', d.payee as string],
      ['Paid', d.payment === 'credit' ? `On credit to ${d.supplier_name}` : `From ${d.account_name}`],
      ['Approval limit here', d.approval_limit_minor != null ? <Money minor={n(d.approval_limit_minor)} /> : null],
    ]} /></div>;
  }
  if (d.type === 'purchase') {
    const lines = (d.lines as { name: string; qty: string; unit: string; totalMinor: number }[] | null) ?? [];
    return (
      <div className={cx(box, 'space-y-3')}>
        <Rows rows={[['Supplier', String(d.supplier_name)], ['Paid', d.payment === 'credit' ? 'On credit (udhaar)' : `From ${d.account_name}`],
          ['Already owed to supplier', <Money minor={n(d.supplier_owed_minor)} />], ['Note', d.note as string]]} />
        <table className="w-full text-sm"><tbody>
          {lines.map((l, i) => (
            <tr key={i} className="border-t border-[var(--line)]"><td className="py-1.5">{l.name}</td><td className="text-right tabular">{Number(l.qty)} {l.unit}</td>
              <td className="text-right"><Money minor={l.totalMinor} /></td></tr>
          ))}
        </tbody></table>
      </div>
    );
  }
  if (d.type === 'day_close') {
    const f = d.figures as Record<string, number>;
    const lines = (d.lines as { name: string; kind: string; expected_minor: number; declared_minor: number; difference_minor: number }[]) ?? [];
    return (
      <div className={cx(box, 'space-y-3')}>
        <Rows rows={[['Sales', <Money minor={f.sales} />], ['Refunds', <Money minor={f.refunds} />], ['Cost of food used', <Money minor={f.cogs} />],
          ['All costs', <Money minor={f.expenses} />], ['Profit (estimate)', <Money minor={f.profit} />], ['Opening float', <Money minor={n(d.opening_float_minor)} />],
          ['Note from the stall', d.closing_note as string]]} />
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-[var(--muted)]"><th className="py-1">Account</th><th className="text-right">Books</th><th className="text-right">Counted</th><th className="text-right">Difference</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.name} className="border-t border-[var(--line)]"><td className="py-1.5">{l.name}</td><td className="text-right"><Money minor={l.expected_minor} /></td>
              <td className="text-right"><Money minor={l.declared_minor} /></td>
              <td className="text-right">{l.difference_minor === 0 ? <Badge tone="good">OK</Badge> : <Money minor={l.difference_minor} sign />}</td></tr>
          ))}</tbody>
        </table>
      </div>
    );
  }
  if (d.type === 'capital') {
    return <div className={box}><Rows rows={[['Person', String(d.person_name)], ['Account', d.account_name as string], ['Reason', d.reason as string],
      ['Loan amount', d.loan_principal_minor != null ? <Money minor={n(d.loan_principal_minor)} /> : null], ['Loan due', d.loan_due_date as string]]} /></div>;
  }
  if (d.type === 'shares') {
    const cur = (d.current as { name: string; weight: string }[]) ?? [];
    const tot = cur.reduce((a, c) => a + Number(c.weight), 0);
    return (
      <div className={cx(box, 'grid gap-3 sm:grid-cols-2 text-sm')}>
        <div><div className="mb-1 font-medium">Now</div>{cur.map((c) => <div key={c.name}>{c.name}: {tot ? ((Number(c.weight) / tot) * 100).toFixed(2) : 0}%</div>)}</div>
        <div><div className="mb-1 font-medium">Proposed from {String(d.effective_from)}</div>
          {((d.proposed as { name: string; percent: number }[]) ?? []).map((p) => <div key={p.name}>{p.name}: {p.percent}%</div>)}</div>
        {d.reason ? <p className="sm:col-span-2 text-[var(--muted)]">Reason: {String(d.reason)}</p> : null}
      </div>
    );
  }
  return null;
}
