import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../api';
import { Button, cx, Empty, ErrorText, Loading, PageHeader, Tabs, useToast } from '../components/ui';
import { timeLabel } from '../format';
import { useSession } from '../session';

interface Note { id: string; org_id: string | null; type: string; title: string; body: string; link: string | null; created_at: string; read_at: string | null }

const ICON: Record<string, string> = {
  approval_request: '✓', approval_reminder: '⏰', approval_decided: '✓', daily_close_reminder: '☀', low_stock: '▤', daily_summary: '▲',
  question_asked: '?', question_followup: '?', payout_made: '₨', loan_refund_confirm: '₨',
};

export function Notifications() {
  const s = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [view, setView] = useState<'all' | 'unread'>('all');
  const list = useQuery({ queryKey: ['notifications', 'list'], queryFn: () => get<{ items: Note[]; unread: number }>('/notifications'), refetchInterval: 30_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({
    mutationFn: (ids: string[] | 'all') => post('/notifications/read', { ids }),
    onSuccess: (_d, ids) => { if (ids === 'all') toast('All marked as read'); void refresh(); },
    onError: (e) => toast(e.message, 'bad'),
  });

  const open = (n: Note) => {
    if (!n.read_at) markRead.mutate([n.id]);
    if (n.org_id && s.org && n.org_id !== s.org.id && s.orgs.some((o) => o.id === n.org_id)) s.setOrgId(n.org_id);
    if (n.link) nav(n.link);
  };

  const items = (list.data?.items ?? []).filter((n) => view === 'all' || !n.read_at);
  const unread = list.data?.unread ?? 0;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Notifications" sub={unread > 0 ? `${unread} unread` : 'All caught up'}
        actions={unread > 0 ? <Button size="sm" busy={markRead.isPending && markRead.variables === 'all'} onClick={() => markRead.mutate('all')}>Mark all read</Button> : undefined} />
      <Tabs value={view} onChange={setView} tabs={[{ value: 'all', label: 'All' }, { value: 'unread', label: `Unread${unread ? ` (${unread})` : ''}` }]} />
      <ErrorText error={list.error} />
      {list.isLoading ? <Loading /> : items.length === 0 ? (
        <Empty>{view === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}</Empty>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id}>
              <div className={cx('flex items-stretch gap-1 rounded-2xl border bg-[var(--panel)]',
                n.read_at ? 'border-[var(--line)]' : 'border-brand/60 bg-brand/5')}>
                <button onClick={() => open(n)} className="flex min-h-16 min-w-0 flex-1 items-start gap-3 rounded-2xl p-3 text-left active:bg-[var(--panel-2)]">
                  <span aria-hidden className={cx('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base',
                    n.read_at ? 'bg-[var(--panel-2)] text-[var(--muted)]' : 'bg-brand text-brand-ink')}>{ICON[n.type] ?? '•'}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cx('block leading-snug', !n.read_at && 'font-semibold')}>{n.title}</span>
                    {n.body ? <span className="mt-0.5 block text-sm text-[var(--muted)]">{n.body}</span> : null}
                    <span className="mt-1 block text-xs text-[var(--muted)]">{timeLabel(n.created_at)}{n.link ? ' · Tap to open' : ''}</span>
                  </span>
                  {!n.read_at && <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                </button>
                {!n.read_at && (
                  <button onClick={() => markRead.mutate([n.id])} aria-label="Mark as read"
                    className="w-14 shrink-0 rounded-r-2xl border-l border-[var(--line)] text-xs text-[var(--muted)] hover:bg-[var(--panel-2)]">
                    Mark read
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-center text-sm text-[var(--muted)]">
        Choose which alerts you get in <Link to="/settings" className="underline">My account → notification settings</Link>.
      </p>
    </div>
  );
}
