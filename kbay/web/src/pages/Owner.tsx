import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, patch } from '../api';
import { Badge, Button, Card, cx, Empty, ErrorText, Loading, Modal, PageHeader, Stat, useToast } from '../components/ui';
import { dateLabel, timeLabel } from '../format';
import { useSession } from '../session';
import { Toggle } from './Admin';

// The application owner's control room (Opplox): every customer (tenant), what their plan
// includes, and the platform's health. Shown only to the platform owner account.

interface Tenant {
  id: string; slug: string; name: string; active: boolean; otp_enabled: boolean; created_at: string;
  orgs: number; locations: number; users: number; modules: Record<string, boolean>;
}
interface Health {
  db: { time: string; size: string };
  outbox: { pending: number; failing: number; oldest: string | null };
  pushQueue: number;
  schema: string | null;
  audit: { ok: boolean; checked: number; brokenAt: number | null };
}

const MODULE_LABELS: Record<string, { label: string; sub: string }> = {
  pos: { label: 'Point of sale', sub: 'Selling, the menu and orders' },
  inventory: { label: 'Stock', sub: 'Stock levels, recipes, counts, waste' },
  finance: { label: 'Money', sub: 'Accounts, ledger, spends, the business day' },
  approvals: { label: 'Approvals', sub: 'Partner sign-off on spends and closes' },
  reports: { label: 'Reports', sub: 'Sales, profit and partner reports' },
  investor_portal: { label: 'Investor portal', sub: 'Investors see their capital and returns' },
  customer_ordering: { label: 'Customer ordering', sub: 'Customers order from their phones' },
  ai_entry: { label: 'AI entry', sub: 'Enter spends and stock by photo or voice' },
  cameras: { label: 'Cameras', sub: 'Stall camera links' },
};

export function Owner() {
  const { me } = useSession();
  if (!me?.user.isPlatformOwner) {
    return (
      <>
        <PageHeader title="Owner" />
        <Empty>This page is only for the platform owner.</Empty>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Platform owner" sub="Every customer on Opplox, what their plan includes, and how the platform is running." />
      <div className="space-y-6">
        <div className="rounded-xl bg-amber-500/15 p-3 text-sm">
          <b>Protect this account.</b> It controls every customer. Turn on two-factor sign-in in{' '}
          <Link to="/settings" className="font-medium underline">My account</Link>.
        </div>
        <HealthPanel />
        <Tenants />
      </div>
    </>
  );
}

function HealthPanel() {
  const h = useQuery({ queryKey: ['owner', 'health'], queryFn: () => get<Health>('/owner/health'), refetchInterval: 60_000 });
  return (
    <Card title="Platform health" actions={<Button size="sm" busy={h.isFetching} onClick={() => void h.refetch()}>Refresh</Button>}>
      {h.isLoading ? <Loading /> : h.error ? <ErrorText error={h.error} /> : h.data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Database" value={h.data.db.size} sub={`Server time ${timeLabel(h.data.db.time)}`} />
          <Stat label="Order events waiting" value={h.data.outbox.pending} tone={h.data.outbox.failing > 0 ? 'bad' : undefined}
            sub={h.data.outbox.failing > 0 ? `${h.data.outbox.failing} failing${h.data.outbox.oldest ? ` · oldest ${timeLabel(h.data.outbox.oldest)}` : ''}`
              : h.data.outbox.oldest ? `Oldest ${timeLabel(h.data.outbox.oldest)}` : 'None failing'} />
          <Stat label="Push queue" value={h.data.pushQueue} sub="Notifications not yet sent to phones" />
          <Stat label="Schema version" value={<span className="break-all text-base">{h.data.schema ?? '—'}</span>} sub="Latest database migration" />
          <Stat label="Audit chain" value={h.data.audit.ok ? 'Intact' : 'Broken'} tone={h.data.audit.ok ? 'good' : 'bad'}
            sub={h.data.audit.ok ? `${h.data.audit.checked.toLocaleString('en-PK')} entries checked` : `Edited or removed at entry #${h.data.audit.brokenAt}`} />
        </div>
      )}
    </Card>
  );
}

function Tenants() {
  const qc = useQueryClient();
  const toast = useToast();
  const tenants = useQuery({ queryKey: ['owner', 'tenants'], queryFn: () => get<Tenant[]>('/owner/tenants') });
  const modules = useQuery({ queryKey: ['owner', 'modules'], queryFn: () => get<string[]>('/owner/modules'), staleTime: Infinity });
  const [confirmOff, setConfirmOff] = useState<Tenant | null>(null);
  const update = useMutation({
    mutationFn: (v: { id: string; body: { active?: boolean; otpEnabled?: boolean; modules?: Record<string, boolean> } }) => patch(`/owner/tenants/${v.id}`, v.body),
    onSuccess: () => { toast('Saved'); void qc.invalidateQueries({ queryKey: ['owner', 'tenants'] }); },
    onError: (e) => toast(e.message, 'bad'),
  });
  if (tenants.isLoading || modules.isLoading) return <Loading />;
  if (tenants.error || modules.error) return <ErrorText error={tenants.error ?? modules.error} />;
  const keys = modules.data ?? [];
  const list = tenants.data ?? [];
  const pendingFor = (id: string) => update.isPending && update.variables?.id === id;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Customers</h2>
        <p className="text-sm text-[var(--muted)]">
          Modules are <b>what each customer's plan includes</b>. Switching one off hides that part of the app for that customer only.
        </p>
      </div>
      {list.length === 0 ? <Empty>No customers yet.</Empty> : list.map((t) => (
        <Card key={t.id} className={cx(!t.active && 'opacity-80')}
          title={<span className="flex flex-wrap items-center gap-2">{t.name}<span className="text-sm font-normal text-[var(--muted)]">{t.slug}</span>
            {t.active ? <Badge tone="good">Active</Badge> : <Badge tone="bad">Suspended</Badge>}</span>}>
          <div className="grid grid-cols-3 gap-2 text-center text-sm sm:max-w-md">
            {([['Organizations', t.orgs], ['Locations', t.locations], ['Users', t.users]] as const).map(([l, n]) => (
              <div key={l} className="rounded-xl bg-[var(--panel-2)] p-2">
                <div className="text-xl font-bold tabular">{n}</div>
                <div className="text-xs text-[var(--muted)]">{l}</div>
              </div>
            ))}
          </div>
          <div className="mt-1 text-xs text-[var(--muted)]">Customer since {dateLabel(t.created_at)}</div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <SwitchRow label="Account active" sub="Off suspends this customer." on={t.active} busy={pendingFor(t.id)}
              onChange={(v) => (v ? update.mutate({ id: t.id, body: { active: true } }) : setConfirmOff(t))} />
            <SwitchRow label="One-time codes (OTP)" sub="Extra sign-in check for this customer's users." on={t.otp_enabled} busy={pendingFor(t.id)}
              onChange={(v) => update.mutate({ id: t.id, body: { otpEnabled: v } })} />
          </div>

          <details className="mt-4" open={list.length <= 3}>
            <summary className="cursor-pointer text-sm font-semibold">Plan modules ({keys.filter((k) => t.modules[k] ?? true).length} of {keys.length} on)</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {keys.map((k) => (
                <SwitchRow key={k} label={MODULE_LABELS[k]?.label ?? k} sub={MODULE_LABELS[k]?.sub} on={t.modules[k] ?? true} busy={pendingFor(t.id)}
                  onChange={(v) => update.mutate({ id: t.id, body: { modules: { [k]: v } } })} />
              ))}
            </div>
          </details>
        </Card>
      ))}
      <Modal open={!!confirmOff} onClose={() => setConfirmOff(null)} title={`Suspend ${confirmOff?.name ?? ''}?`} footer={<>
        <Button variant="ghost" onClick={() => setConfirmOff(null)}>Cancel</Button>
        <Button variant="danger" busy={update.isPending} onClick={() => {
          if (confirmOff) update.mutate({ id: confirmOff.id, body: { active: false } }, { onSuccess: () => setConfirmOff(null) });
        }}>Suspend</Button>
      </>}>
        <p className="text-sm">The customer's account is marked suspended. Their data is kept and you can switch it back on at any time.</p>
      </Modal>
    </section>
  );
}

function SwitchRow({ label, sub, on, busy, onChange }: { label: string; sub?: string; on: boolean; busy?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {sub ? <div className="text-xs text-[var(--muted)]">{sub}</div> : null}
      </div>
      <Toggle on={on} label={label} disabled={busy} onChange={onChange} />
    </div>
  );
}
