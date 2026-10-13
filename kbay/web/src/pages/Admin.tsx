import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { del, get, patch, post, put, qs } from '../api';
import { Badge, Button, Card, cx, Empty, ErrorText, Field, Input, Loading, Modal, Money, MoneyInput, PageHeader, Select, Tabs, Textarea, useToast } from '../components/ui';
import { rs, timeLabel } from '../format';
import { useScope, useSession } from '../session';

// Admin: people and logins, roles and rights, locations, the menu, notification rules and the
// audit trail. Each tab appears only for people holding the permission that tab needs.

type TabKey = 'people' | 'roles' | 'locations' | 'menu' | 'alerts' | 'audit';
const TABS: { value: TabKey; label: string; perm: string }[] = [
  { value: 'people', label: 'People & logins', perm: 'users.manage' },
  { value: 'roles', label: 'Roles & access', perm: 'roles.manage' },
  { value: 'locations', label: 'Locations', perm: 'settings.manage' },
  { value: 'menu', label: 'Menu', perm: 'menu.manage' },
  { value: 'alerts', label: 'Notification rules', perm: 'settings.manage' },
  { value: 'audit', label: 'Audit trail', perm: 'audit.view' },
];

export function Admin() {
  const { org, can } = useScope();
  const tabs = TABS.filter((t) => can(t.perm));
  const [tab, setTab] = useState<TabKey>('people');
  const current = tabs.find((t) => t.value === tab)?.value ?? tabs[0]?.value;
  if (!org) return <Empty>No organization is set up yet.</Empty>;
  if (!current) {
    return (
      <>
        <PageHeader title="Admin" />
        <Empty>You don't have admin rights in {org.brand_name}.</Empty>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Admin" sub={`${org.brand_name} — people, access, locations, menu and records`} />
      <Tabs tabs={tabs.map(({ value, label }) => ({ value, label }))} value={current} onChange={setTab} />
      {current === 'people' && <PeopleTab />}
      {current === 'roles' && <RolesTab />}
      {current === 'locations' && <LocationsTab />}
      {current === 'menu' && <MenuTab />}
      {current === 'alerts' && <NotificationRulesTab />}
      {current === 'audit' && <AuditTab />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Small shared pieces

/** An on/off switch sized for fingers. */
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!on)}
      className={cx('relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:opacity-50',
        on ? 'bg-green-700' : 'bg-[var(--line)]')}>
      <span className={cx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', on ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function Check({ checked, onChange, children, className }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-2 py-1 text-sm', className)}>
      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-brand" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/** A big tappable radio option. */
function Choice({ checked, onSelect, title, sub }: { checked: boolean; onSelect: () => void; title: string; sub?: ReactNode }) {
  return (
    <button type="button" onClick={onSelect} aria-pressed={checked}
      className={cx('w-full rounded-xl border p-3 text-left', checked ? 'border-brand bg-brand/10 ring-2 ring-brand/30' : 'border-[var(--line)]')}>
      <div className="flex items-center gap-2 font-medium">
        <span className={cx('inline-block h-4 w-4 shrink-0 rounded-full border-2', checked ? 'border-brand bg-brand' : 'border-[var(--muted)]')} />
        {title}
      </div>
      {sub ? <div className="mt-1 pl-6 text-sm text-[var(--muted)]">{sub}</div> : null}
    </button>
  );
}

function Note({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' }) {
  return <div className={cx('mb-4 rounded-xl p-3 text-sm', tone === 'warn' ? 'bg-amber-500/15' : 'bg-[var(--panel-2)]')}>{children}</div>;
}

interface Ask { title: string; body: ReactNode; action: string; danger?: boolean; run: () => Promise<unknown> }

function ConfirmModal({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const close = () => { setError(null); onClose(); };
  const go = async () => {
    if (!ask) return;
    setBusy(true);
    setError(null);
    try {
      await ask.run();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!ask} onClose={close} title={ask?.title ?? ''} footer={<>
      <Button variant="ghost" onClick={close}>Cancel</Button>
      <Button variant={ask?.danger ? 'danger' : 'primary'} busy={busy} onClick={go}>{ask?.action}</Button>
    </>}>
      <div className="space-y-3 text-sm">{ask?.body}<ErrorText error={error} /></div>
    </Modal>
  );
}

interface Shown { name: string; username: string; password: string; reset: boolean }

/** Shows a temporary password exactly once. */
function TempPasswordModal({ shown, onClose }: { shown: Shown | null; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal open={!!shown} onClose={onClose} title={shown?.reset ? 'New temporary password' : 'Login created'}
      footer={<Button variant="primary" onClick={onClose}>Done, I have noted it</Button>}>
      {shown && (
        <div className="space-y-4">
          <p className="text-sm">Give these to <b>{shown.name}</b>. The password is shown <b>only this once</b>.</p>
          <div className="space-y-3 rounded-xl bg-[var(--panel-2)] p-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Username</div>
              <div className="select-all font-mono text-lg">{shown.username}</div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Temporary password</div>
              <div className="select-all break-all font-mono text-2xl font-bold">{shown.password}</div>
            </div>
          </div>
          <Button className="w-full" onClick={async () => {
            const ok = await copyText(`Username: ${shown.username}\nTemporary password: ${shown.password}`);
            toast(ok ? 'Copied' : 'Could not copy. Please write it down.', ok ? 'good' : 'bad');
          }}>Copy username and password</Button>
          <p className="rounded-xl bg-amber-500/15 p-3 text-sm">
            They must change it on first sign-in. If it gets lost, use “Reset password” to make a new one.
          </p>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// People & logins

interface Person {
  id: string; full_name: string; display_name: string | null; phone: string | null; email: string | null; cnic: string | null;
  address: string | null; notes: string | null; created_at: string; user_id: string | null; username: string | null;
}
interface RoleGrant { assignmentId: string; roleId: string; roleKey: string; roleName: string; allOrgs: boolean; orgIds: string[]; locationIds: string[] }
interface OverrideRow { id: string; permission: string; orgId: string | null; effect: 'grant' | 'deny' }
interface UserRow {
  id: string; username: string; active: boolean; must_change_password: boolean; last_login_at: string | null; totp_enabled: boolean;
  person_id: string | null; full_name: string | null; display_name: string | null; phone: string | null;
  roles: RoleGrant[]; overrides: OverrideRow[];
}

const personName = (p: { display_name: string | null; full_name: string | null }, fallback = '') => p.display_name || p.full_name || fallback;

function useAdminUsers() {
  const { orgId } = useScope();
  return useQuery({ queryKey: ['admin-users', orgId], queryFn: () => get<UserRow[]>(`/orgs/${orgId}/users`) });
}

function PeopleTab() {
  const { orgId, me } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const people = useQuery({ queryKey: ['people', orgId], queryFn: () => get<Person[]>(`/orgs/${orgId}/people`) });
  const users = useAdminUsers();
  const [editing, setEditing] = useState<Person | 'new' | null>(null);
  const [loginFor, setLoginFor] = useState<Person | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [search, setSearch] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['people'] });
    void qc.invalidateQueries({ queryKey: ['admin-users'] });
  };

  if (people.isLoading || users.isLoading) return <Loading />;
  if (people.error || users.error) return <ErrorText error={people.error ?? users.error} />;
  const all = people.data ?? [];
  const logins = users.data ?? [];
  const byPerson = new Map(logins.filter((u) => u.person_id).map((u) => [u.person_id!, u]));
  const onFile = new Set(all.map((p) => p.id));
  const otherLogins = logins.filter((u) => !u.person_id || !onFile.has(u.person_id));
  const term = search.trim().toLowerCase();
  const shownPeople = all.filter((p) => !term || [p.full_name, p.display_name, p.phone, p.email, p.cnic, byPerson.get(p.id)?.username]
    .some((x) => x?.toLowerCase().includes(term)));

  const reset = (u: UserRow, name: string) => setAsk({
    title: 'Reset password?',
    body: <p>{name} (@{u.username}) will be signed out everywhere and get a new temporary password.</p>,
    action: 'Reset password',
    run: async () => {
      const r = await post<{ temporaryPassword: string }>(`/orgs/${orgId}/users/${u.id}/reset-password`);
      setShown({ name, username: u.username, password: r.temporaryPassword, reset: true });
      refresh();
    },
  });
  const setActive = (u: UserRow, name: string, active: boolean) => setAsk({
    title: active ? 'Enable login?' : 'Disable login?',
    body: active ? <p>{name} will be able to sign in again.</p>
      : <p>{name} (@{u.username}) will be signed out and cannot sign in until enabled again. Their records stay.</p>,
    action: active ? 'Enable' : 'Disable',
    danger: !active,
    run: async () => {
      await post(`/orgs/${orgId}/users/${u.id}/active`, { active });
      toast(active ? 'Login enabled' : 'Login disabled');
      refresh();
    },
  });

  const loginBits = (u: UserRow | undefined, name: string, p?: Person) => (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {u ? (
          <>
            <Badge tone="brand">@{u.username}</Badge>
            {u.active ? <Badge tone="good">Can sign in</Badge> : <Badge tone="bad">Disabled</Badge>}
            {u.must_change_password && <Badge tone="warn">Temporary password</Badge>}
            {u.totp_enabled && <Badge>2FA on</Badge>}
            {u.roles.map((r) => <Badge key={r.assignmentId}>{r.roleName}</Badge>)}
            {u.roles.length === 0 && u.overrides.length === 0 && <Badge tone="warn">No role yet</Badge>}
          </>
        ) : <Badge>No login</Badge>}
      </div>
      {u && <div className="text-xs text-[var(--muted)]">Last sign-in: {u.last_login_at ? timeLabel(u.last_login_at) : 'never'}</div>}
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {u ? (
          <>
            <Button size="sm" onClick={() => reset(u, name)}>Reset password</Button>
            {u.id !== me.user.userId && (
              <Button size="sm" variant={u.active ? 'ghost' : 'good'} onClick={() => setActive(u, name, !u.active)}>
                {u.active ? 'Disable login' : 'Enable login'}
              </Button>
            )}
          </>
        ) : p ? <Button size="sm" variant="primary" onClick={() => setLoginFor(p)}>Create login</Button> : null}
      </div>
    </>
  );

  return (
    <div className="space-y-4">
      <Note>
        Everyone on file — staff, partners, investors. A person needs a <b>login</b> to use the app; what they can do comes from the
        roles and rights set under <b>Roles &amp; access</b>.
      </Note>
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1 sm:max-w-xs" placeholder="Search name, phone, username…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button variant="primary" onClick={() => setEditing('new')}>Add a person</Button>
      </div>
      {shownPeople.length === 0 ? <Empty>{all.length ? 'Nobody matches that search.' : 'No people yet. Add the first one.'}</Empty> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shownPeople.map((p) => {
            const u = byPerson.get(p.id);
            const name = personName(p);
            return (
              <div key={p.id} className="flex flex-col gap-2 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{name}</div>
                    {p.display_name && p.display_name !== p.full_name && <div className="truncate text-sm text-[var(--muted)]">{p.full_name}</div>}
                    <div className="text-sm text-[var(--muted)]">{[p.phone, p.email, p.cnic && `CNIC ${p.cnic}`].filter(Boolean).join(' · ') || 'No contact details'}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>Edit</Button>
                </div>
                {loginBits(u, name, p)}
              </div>
            );
          })}
        </div>
      )}
      {otherLogins.length > 0 && (
        <Card title="Other logins" actions={<span className="text-xs text-[var(--muted)]">Not linked to a person in this organization</span>}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {otherLogins.map((u) => (
              <div key={u.id} className="flex flex-col gap-2 rounded-xl border border-[var(--line)] p-3">
                <div className="font-semibold">{personName(u, u.username)}</div>
                {loginBits(u, personName(u, u.username))}
              </div>
            ))}
          </div>
        </Card>
      )}
      {editing && <PersonModal key={editing === 'new' ? 'new' : editing.id} person={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {loginFor && (
        <CreateLoginModal person={loginFor} onClose={() => setLoginFor(null)}
          onCreated={(username, password) => { setLoginFor(null); setShown({ name: personName(loginFor), username, password, reset: false }); refresh(); }} />
      )}
      <TempPasswordModal shown={shown} onClose={() => setShown(null)} />
      <ConfirmModal ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

const PERSON_FIELDS = [
  { key: 'fullName', col: 'full_name', label: 'Full name', required: true },
  { key: 'displayName', col: 'display_name', label: 'Display name', hint: 'Short name shown in the app, e.g. “Ali”.' },
  { key: 'phone', col: 'phone', label: 'Phone', type: 'tel' },
  { key: 'email', col: 'email', label: 'Email', type: 'email' },
  { key: 'cnic', col: 'cnic', label: 'CNIC', hint: 'e.g. 35202-1234567-1' },
  { key: 'address', col: 'address', label: 'Address' },
] as const;

function PersonModal({ person, onClose, onSaved }: { person: Person | null; onClose: () => void; onSaved: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const [f, setF] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = { notes: person?.notes ?? '' };
    for (const d of PERSON_FIELDS) o[d.key] = person?.[d.col] ?? '';
    return o;
  });
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) if (v.trim()) body[k] = v.trim();
      return person ? patch(`/orgs/${orgId}/people/${person.id}`, body) : post(`/orgs/${orgId}/people`, body);
    },
    onSuccess: () => { toast(person ? 'Saved' : 'Person added'); onSaved(); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={person ? `Edit ${personName(person)}` : 'Add a person'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" busy={save.isPending} disabled={f.fullName.trim().length < 2} onClick={() => save.mutate()}>Save</Button>
    </>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {PERSON_FIELDS.map((d) => (
          <Field key={d.key} label={d.label} hint={'hint' in d ? d.hint : undefined} className={d.key === 'address' ? 'sm:col-span-2' : undefined}>
            <Input type={'type' in d ? d.type : 'text'} value={f[d.key]} required={'required' in d} onChange={(e) => setF((x) => ({ ...x, [d.key]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Notes" className="sm:col-span-2"><Textarea value={f.notes} onChange={(e) => setF((x) => ({ ...x, notes: e.target.value }))} /></Field>
        {person && <p className="text-xs text-[var(--muted)] sm:col-span-2">Blank fields keep their old value. To change a detail, type the new one.</p>}
        <div className="sm:col-span-2"><ErrorText error={save.error} /></div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

const suggestUsername = (p: Person) => personName(p).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 40);

function CreateLoginModal({ person, onClose, onCreated }: { person: Person; onClose: () => void; onCreated: (username: string, password: string) => void }) {
  const { orgId } = useScope();
  const [username, setUsername] = useState(() => suggestUsername(person));
  const valid = /^[a-z0-9._-]{3,40}$/i.test(username);
  const create = useMutation({
    mutationFn: () => post<{ id: string; temporaryPassword: string }>(`/orgs/${orgId}/users`, { personId: person.id, username: username.trim() }),
    onSuccess: (r) => onCreated(username.trim().toLowerCase(), r.temporaryPassword),
  });
  return (
    <Modal open onClose={onClose} title={`Create a login for ${personName(person)}`} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!valid} busy={create.isPending} onClick={() => create.mutate()}>Create login</Button>
    </>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
        <Field label="Username" hint="3–40 letters, numbers, dots, dashes or underscores. They type this to sign in.">
          <Input autoCapitalize="none" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </Field>
        <p className="text-sm text-[var(--muted)]">A temporary password is made for them and shown once. Then give them a role under Roles &amp; access.</p>
        <ErrorText error={create.error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Roles & access

interface Role { id: string; key: string; name: string; description: string | null; permissions: string[]; is_system: boolean }
interface PermDef { key: string; label: string }

const AREA: Record<string, string> = {
  pos: 'Selling', day: 'Business day', expense: 'Spending & suppliers', purchase: 'Spending & suppliers', supplier: 'Spending & suppliers',
  inventory: 'Stock', menu: 'Menu', finance: 'Money', accounts: 'Money', capital: 'Money', partners: 'Money', payroll: 'Money',
  reports: 'Reports', investor: 'Reports', approve: 'Approvals', comment: 'Questions', users: 'Administration', roles: 'Administration',
  settings: 'Administration', audit: 'Administration',
};

function groupPerms(perms: PermDef[]) {
  const groups: { area: string; perms: PermDef[] }[] = [];
  for (const p of perms) {
    const area = AREA[p.key.split('.')[0]!] ?? 'Other';
    let g = groups.find((x) => x.area === area);
    if (!g) groups.push((g = { area, perms: [] }));
    g.perms.push(p);
  }
  return groups;
}

function usePermissions() {
  return useQuery({ queryKey: ['permissions'], queryFn: () => get<PermDef[]>('/permissions'), staleTime: Infinity });
}

function RolesTab() {
  const { orgId, org } = useScope();
  const { orgs } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useQuery({ queryKey: ['roles', orgId], queryFn: () => get<Role[]>(`/orgs/${orgId}/roles`) });
  const perms = usePermissions();
  const users = useAdminUsers();
  const [editRole, setEditRole] = useState<Role | 'new' | null>(null);
  const [assignFor, setAssignFor] = useState<UserRow | null>(null);
  const [rightFor, setRightFor] = useState<UserRow | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [search, setSearch] = useState('');

  if (roles.isLoading || perms.isLoading || users.isLoading) return <Loading />;
  if (roles.error || perms.error || users.error) return <ErrorText error={roles.error ?? perms.error ?? users.error} />;
  const permLabel = new Map((perms.data ?? []).map((p) => [p.key, p.label]));
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.brand_name ?? 'another organization';
  const locName = (id: string) => orgs.flatMap((o) => o.locations).find((l) => l.id === id)?.name ?? 'a location';
  const scopeText = (a: RoleGrant) => `${a.allOrgs ? 'All organizations' : a.orgIds.map(orgName).join(', ')}${a.locationIds.length ? ` · only at ${a.locationIds.map(locName).join(', ')}` : ''}`;
  const refreshUsers = () => { void qc.invalidateQueries({ queryKey: ['admin-users'] }); void qc.invalidateQueries({ queryKey: ['workspace'] }); };
  const term = search.trim().toLowerCase();
  const list = (users.data ?? []).filter((u) => !term || [u.username, u.full_name, u.display_name].some((x) => x?.toLowerCase().includes(term)));

  return (
    <div className="space-y-4">
      <Note>
        <b>Nothing is hard-coded.</b> A person's rights are the roles you give them (within the organizations and locations you pick),
        plus any single rights granted to them, minus any rights denied. A deny always wins. Roles are shared by all your organizations.
      </Note>

      <Card title="Roles" actions={<Button size="sm" variant="primary" onClick={() => setEditRole('new')}>New role</Button>}>
        {(roles.data ?? []).length === 0 ? <Empty>No roles yet.</Empty> : (
          <div className="grid gap-3 md:grid-cols-2">
            {roles.data!.map((r) => (
              <div key={r.id} className="rounded-xl border border-[var(--line)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-semibold">{r.name}{r.is_system && <Badge>Built-in</Badge>}</div>
                    {r.description && <div className="text-sm text-[var(--muted)]">{r.description}</div>}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setEditRole(r)}>Edit</Button>
                </div>
                <div className="mt-2 text-sm">
                  {r.permissions.includes('*') ? <Badge tone="brand">Everything (super admin)</Badge> : (
                    <details>
                      <summary className="cursor-pointer text-[var(--muted)]">{r.permissions.length} right{r.permissions.length === 1 ? '' : 's'}</summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5">{r.permissions.map((p) => <li key={p}>{permLabel.get(p) ?? p}</li>)}</ul>
                    </details>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Who can do what" actions={<Input className="h-9 w-48" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />}>
        {list.length === 0 ? <Empty>No logins yet. Create one under People &amp; logins.</Empty> : (
          <div className="space-y-3">
            {list.map((u) => (
              <div key={u.id} className="rounded-xl border border-[var(--line)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{personName(u, u.username)} <span className="text-sm font-normal text-[var(--muted)]">@{u.username}</span></div>
                    {!u.active && <Badge tone="bad">Login disabled</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" onClick={() => setAssignFor(u)}>Give a role</Button>
                    <Button size="sm" onClick={() => setRightFor(u)}>Single right</Button>
                  </div>
                </div>
                <div className="mt-2 space-y-1.5">
                  {u.roles.length === 0 && u.overrides.length === 0 && <p className="text-sm text-[var(--muted)]">No roles or rights yet — they can sign in but do nothing.</p>}
                  {u.roles.map((a) => (
                    <div key={a.assignmentId} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--panel-2)] px-3 py-2 text-sm">
                      <div className="min-w-0"><b>{a.roleName}</b> <span className="text-[var(--muted)]">— {scopeText(a)}</span></div>
                      <Button size="sm" variant="ghost" onClick={() => setAsk({
                        title: 'Remove this role?', danger: true, action: 'Remove role',
                        body: <p>{personName(u, u.username)} will lose <b>{a.roleName}</b> ({scopeText(a)}).</p>,
                        run: async () => { await del(`/orgs/${orgId}/role-assignments/${a.assignmentId}`); toast('Role removed'); refreshUsers(); },
                      })}>Remove</Button>
                    </div>
                  ))}
                  {u.overrides.map((o) => (
                    <div key={o.id} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--panel-2)] px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <Badge tone={o.effect === 'grant' ? 'good' : 'bad'}>{o.effect === 'grant' ? 'Allowed' : 'Denied'}</Badge>{' '}
                        {permLabel.get(o.permission) ?? o.permission} <span className="text-[var(--muted)]">— {o.orgId ? orgName(o.orgId) : 'all organizations'}</span>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setAsk({
                        title: 'Clear this single right?', action: 'Clear',
                        body: <p>“{permLabel.get(o.permission) ?? o.permission}” for {personName(u, u.username)} will go back to whatever their roles say.</p>,
                        run: async () => {
                          await post(`/orgs/${orgId}/permission-overrides`, { userId: u.id, permission: o.permission, effect: 'clear', scopeOrgId: o.orgId });
                          toast('Cleared'); refreshUsers();
                        },
                      })}>Clear</Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editRole && <RoleModal key={editRole === 'new' ? 'new' : editRole.id} role={editRole === 'new' ? null : editRole} perms={perms.data ?? []}
        onClose={() => setEditRole(null)} />}
      {assignFor && <AssignModal user={assignFor} roles={roles.data ?? []} onClose={() => setAssignFor(null)} onDone={refreshUsers} />}
      {rightFor && <RightModal user={rightFor} roles={roles.data ?? []} perms={perms.data ?? []} orgName={org.brand_name}
        onClose={() => setRightFor(null)} onDone={refreshUsers} />}
      <ConfirmModal ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

const slugKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

function RoleModal({ role, perms, onClose }: { role: Role | null; perms: PermDef[]; onClose: () => void }) {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(role?.name ?? '');
  const [key, setKey] = useState(role?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState(role?.description ?? '');
  const [sel, setSel] = useState<Set<string>>(() => new Set(role?.permissions ?? []));
  const groups = useMemo(() => groupPerms(perms), [perms]);
  const everything = sel.has('*');
  const effKey = role ? role.key : keyTouched ? key : slugKey(name);
  const valid = name.trim().length >= 2 && /^[a-z0-9_]{2,40}$/.test(effKey);
  const toggle = (k: string, on: boolean) => setSel((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; });
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/roles`, {
      id: role?.id, key: effKey, name: name.trim(), description: description.trim() || undefined,
      permissions: everything ? ['*'] : [...sel].filter((p) => p !== '*'),
    }),
    onSuccess: () => {
      toast(role ? 'Role saved' : 'Role created');
      void qc.invalidateQueries({ queryKey: ['roles'] });
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      void qc.invalidateQueries({ queryKey: ['workspace'] });
      onClose();
    },
  });
  return (
    <Modal open wide onClose={onClose} title={role ? `Edit role: ${role.name}` : 'New role'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!valid} busy={save.isPending} onClick={() => save.mutate()}>Save role</Button>
    </>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stall lead" autoFocus={!role} /></Field>
          <Field label="Key" hint={role ? 'The key cannot change.' : 'Lowercase letters, numbers and _.'}>
            <Input value={effKey} disabled={!!role} onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toLowerCase()); }} />
          </Field>
          <Field label="Description" className="sm:col-span-2"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this role is for" /></Field>
        </div>
        {role?.is_system && <p className="rounded-xl bg-amber-500/15 p-3 text-sm">This is a built-in role. Changes apply to everyone who has it, in every organization.</p>}
        <Check checked={everything} onChange={(v) => toggle('*', v)} className="rounded-xl border border-[var(--line)] p-3">
          <b>Everything (super admin)</b>
          <span className="block text-[var(--muted)]">Every right, including any added in future.</span>
        </Check>
        {!everything && (
          <div className="grid gap-3 md:grid-cols-2">
            {groups.map((g) => {
              const allOn = g.perms.every((p) => sel.has(p.key));
              return (
                <fieldset key={g.area} className="rounded-xl border border-[var(--line)] p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <legend className="text-sm font-semibold">{g.area}</legend>
                    <button type="button" className="text-xs text-[var(--muted)] underline"
                      onClick={() => setSel((s) => { const n = new Set(s); for (const p of g.perms) { if (allOn) n.delete(p.key); else n.add(p.key); } return n; })}>
                      {allOn ? 'None' : 'All'}
                    </button>
                  </div>
                  {g.perms.map((p) => (
                    <Check key={p.key} checked={sel.has(p.key)} onChange={(v) => toggle(p.key, v)}>{p.label}</Check>
                  ))}
                </fieldset>
              );
            })}
          </div>
        )}
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

function AssignModal({ user, roles, onClose, onDone }: { user: UserRow; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const { orgId } = useScope();
  const { orgs } = useSession();
  const toast = useToast();
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState<'all' | 'some' | null>(null);
  const [orgIds, setOrgIds] = useState<string[]>([orgId]);
  const [limit, setLimit] = useState(false);
  const [locIds, setLocIds] = useState<string[]>([]);
  const scopeOrgs = scope === 'all' ? orgs : orgs.filter((o) => orgIds.includes(o.id));
  const locs = scopeOrgs.flatMap((o) => o.locations.map((l) => ({ ...l, orgName: o.brand_name })));
  const pickedLocs = locIds.filter((id) => locs.some((l) => l.id === id));
  const valid = !!roleId && scope !== null && (scope === 'all' || orgIds.length > 0) && (!limit || pickedLocs.length > 0);
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/role-assignments`, {
      userId: user.id, roleId, allOrgs: scope === 'all', orgIds: scope === 'all' ? [] : orgIds, locationIds: limit ? pickedLocs : [],
    }),
    onSuccess: () => { toast('Role given'); onDone(); onClose(); },
  });
  const tick = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  return (
    <Modal open wide onClose={onClose} title={`Give ${personName(user, user.username)} a role`} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!valid} busy={save.isPending} onClick={() => save.mutate()}>Give role</Button>
    </>}>
      <div className="space-y-4">
        <Field label="Role">
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)} placeholder="Pick a role" options={roles.map((r) => ({ value: r.id, label: r.name }))} />
        </Field>
        <div>
          <div className="mb-2 text-sm font-medium">Where does this role apply?</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Choice checked={scope === 'all'} onSelect={() => setScope('all')} title="All organizations" sub="Every business of this customer, including ones added later." />
            <Choice checked={scope === 'some'} onSelect={() => setScope('some')} title="Only the ones I tick" sub="Pick specific organizations below." />
          </div>
          {scope === 'some' && (
            <div className="mt-2 rounded-xl border border-[var(--line)] p-3">
              {orgs.map((o) => (
                <Check key={o.id} checked={orgIds.includes(o.id)} onChange={(v) => setOrgIds((l) => tick(l, o.id, v))}>{o.brand_name}{o.brand_name !== o.name ? ` (${o.name})` : ''}</Check>
              ))}
            </div>
          )}
        </div>
        {scope !== null && (
          <div>
            <Check checked={limit} onChange={setLimit}><b>Limit to specific locations</b> <span className="text-[var(--muted)]">(e.g. only one stall)</span></Check>
            {limit && (
              <div className="mt-2 rounded-xl border border-[var(--line)] p-3">
                {locs.length === 0 ? <p className="text-sm text-[var(--muted)]">Pick an organization first.</p> : locs.map((l) => (
                  <Check key={l.id} checked={locIds.includes(l.id)} onChange={(v) => setLocIds((x) => tick(x, l.id, v))}>
                    {l.name} <span className="text-[var(--muted)]">· {l.orgName}</span>
                  </Check>
                ))}
              </div>
            )}
          </div>
        )}
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

function RightModal({ user, roles, perms, orgName, onClose, onDone }: {
  user: UserRow; roles: Role[]; perms: PermDef[]; orgName: string; onClose: () => void; onDone: () => void;
}) {
  const { orgId } = useScope();
  const toast = useToast();
  const [perm, setPerm] = useState('');
  const [effect, setEffect] = useState<'grant' | 'deny'>('grant');
  const [where, setWhere] = useState<'org' | 'all'>('org');
  const fromRoles = new Set(user.roles.flatMap((a) => roles.find((r) => r.id === a.roleId)?.permissions ?? []));
  const viaRole = perm && (fromRoles.has('*') || fromRoles.has(perm));
  const options = groupPerms(perms).flatMap((g) => g.perms.map((p) => ({ value: p.key, label: `${g.area}: ${p.label}` })));
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/permission-overrides`, { userId: user.id, permission: perm, effect, scopeOrgId: where === 'org' ? orgId : null }),
    onSuccess: () => { toast(effect === 'grant' ? 'Right given' : 'Right denied'); onDone(); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={`Single right for ${personName(user, user.username)}`} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant={effect === 'deny' ? 'danger' : 'primary'} disabled={!perm} busy={save.isPending} onClick={() => save.mutate()}>
        {effect === 'grant' ? 'Allow' : 'Deny'}
      </Button>
    </>}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--muted)]">Give or take away one right for this person only, e.g. let a salesperson void sales or request refunds.</p>
        <Field label="Right" hint={perm ? (viaRole ? 'Their roles already give this right.' : 'Their roles do not give this right.') : undefined}>
          <Select value={perm} onChange={(e) => setPerm(e.target.value)} placeholder="Pick a right" options={options} />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice checked={effect === 'grant'} onSelect={() => setEffect('grant')} title="Allow" sub="Add this right even if no role gives it." />
          <Choice checked={effect === 'deny'} onSelect={() => setEffect('deny')} title="Deny" sub="Block it even if a role gives it." />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice checked={where === 'org'} onSelect={() => setWhere('org')} title={`Only in ${orgName}`} />
          <Choice checked={where === 'all'} onSelect={() => setWhere('all')} title="In all organizations" />
        </div>
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Locations

interface LocationRow {
  id: string; name: string; kind: 'stall' | 'shop'; city: string | null; address: string | null; approval_limit_minor: number; active: boolean; created_at: string;
}

function LocationsTab() {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const locs = useQuery({ queryKey: ['locations', orgId], queryFn: () => get<LocationRow[]>(`/orgs/${orgId}/locations`) });
  const [editing, setEditing] = useState<LocationRow | 'new' | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['locations'] }); void qc.invalidateQueries({ queryKey: ['workspace'] }); };
  if (locs.isLoading) return <Loading />;
  if (locs.error) return <ErrorText error={locs.error} />;
  const rows = locs.data ?? [];
  return (
    <div className="space-y-4">
      <Note>
        Each stall or shop has its own cash drawer, menu switches and an <b>approval limit</b>: any spend above it needs a partner's approval.
      </Note>
      <div className="flex justify-end"><Button variant="primary" onClick={() => setEditing('new')}>Add a location</Button></div>
      {rows.length === 0 ? <Empty>No locations yet.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((l) => (
            <div key={l.id} className={cx('rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4', !l.active && 'opacity-70')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-semibold">
                    {l.name}<Badge tone="brand">{l.kind === 'stall' ? 'Stall' : 'Shop'}</Badge>{!l.active && <Badge tone="bad">Closed</Badge>}
                  </div>
                  <div className="text-sm text-[var(--muted)]">{[l.city, l.address].filter(Boolean).join(' · ') || 'No address'}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>Edit</Button>
              </div>
              <div className="mt-2 text-sm">Approval needed above <Money minor={l.approval_limit_minor} className="font-semibold" /></div>
              <div className="mt-3">
                {l.active ? (
                  <Button size="sm" onClick={() => setAsk({
                    title: `Close ${l.name}?`, danger: true, action: 'Deactivate',
                    body: <p>{l.name} disappears from the location picker and nobody can sell there. Its history stays. You can reopen it later.</p>,
                    run: async () => { await patch(`/orgs/${orgId}/locations/${l.id}`, { active: false }); toast('Location deactivated'); refresh(); },
                  })}>Deactivate</Button>
                ) : (
                  <Button size="sm" variant="good" onClick={async () => {
                    try { await patch(`/orgs/${orgId}/locations/${l.id}`, { active: true }); toast('Location reopened'); refresh(); }
                    catch (e) { toast(e instanceof Error ? e.message : 'Could not reopen', 'bad'); }
                  }}>Reopen</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <LocationModal key={editing === 'new' ? 'new' : editing.id} loc={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      <ConfirmModal ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function LocationModal({ loc, onClose, onSaved }: { loc: LocationRow | null; onClose: () => void; onSaved: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const [name, setName] = useState(loc?.name ?? '');
  const [kind, setKind] = useState<'stall' | 'shop'>(loc?.kind ?? 'stall');
  const [city, setCity] = useState(loc?.city ?? '');
  const [address, setAddress] = useState(loc?.address ?? '');
  const [limit, setLimit] = useState<number | null>(loc?.approval_limit_minor ?? 500000);
  const valid = name.trim().length >= 2 && limit !== null;
  const save = useMutation({
    mutationFn: () => loc
      ? patch(`/orgs/${orgId}/locations/${loc.id}`, { name: name.trim(), kind, city: city.trim() || null, address: address.trim() || null, approvalLimitMinor: limit })
      : post(`/orgs/${orgId}/locations`, { name: name.trim(), kind, city: city.trim() || undefined, address: address.trim() || undefined, approvalLimitMinor: limit }),
    onSuccess: () => { toast(loc ? 'Location saved' : 'Location added'); onSaved(); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={loc ? `Edit ${loc.name}` : 'Add a location'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!valid} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gulberg stall" /></Field>
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'stall' | 'shop')} options={[{ value: 'stall', label: 'Stall' }, { value: 'shop', label: 'Shop' }]} />
        </Field>
        <Field label="City"><Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Lahore" /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        <Field label="Approval limit" className="sm:col-span-2" hint="Spends above this amount need a partner's approval. Rs 0 means every spend needs approval.">
          <MoneyInput value={limit} onChange={setLimit} />
        </Field>
        <div className="sm:col-span-2"><ErrorText error={save.error} /></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Menu

interface MVariant {
  id: string; menu_item_id: string; name: string; size_tag: string | null; price_minor: number; open_price: boolean;
  recipe_basis_minor: number | null; enabled: boolean; sort: number; has_recipe: boolean; components: { variantId: string; qty: number }[];
}
interface MModifier { id: string; group_id: string; name: string; price_delta_minor: number; enabled: boolean }
interface MGroup { menu_item_id: string; id: string; name: string; min_select: number; max_select: number; modifiers: MModifier[] }
interface MItem {
  id: string; category_id: string; name: string; description: string | null; image: string | null; enabled: boolean; is_deal: boolean;
  sort: number; location_enabled: boolean | null; variants: MVariant[]; modifierGroups: MGroup[];
}
interface MCategory { id: string; name: string; kind: 'food' | 'beverage'; sort: number; items: MItem[] }
interface Tax { id: string; name: string; rate_bps: number; applies_to: 'all' | 'card'; inclusive: boolean; enabled: boolean }

function useMenuRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['menu-admin'] });
    void qc.invalidateQueries({ queryKey: ['menu'] });
  };
}

function MenuTab() {
  const { orgId, locationId } = useScope();
  const [view, setView] = useState<'items' | 'options' | 'taxes'>('items');
  const menu = useQuery({
    queryKey: ['menu-admin', orgId, locationId],
    queryFn: () => get<MCategory[]>(`/orgs/${orgId}/menu${qs({ all: true, locationId: locationId || undefined })}`),
  });
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {([['items', 'Items & prices'], ['options', 'Add-on options'], ['taxes', 'Taxes & fees']] as const).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)}
            className={cx('h-10 rounded-full px-4 text-sm font-medium', view === v ? 'bg-brand text-brand-ink' : 'bg-[var(--panel-2)] text-[var(--muted)]')}>
            {label}
          </button>
        ))}
      </div>
      {view === 'taxes' ? <TaxesView /> : menu.isLoading ? <Loading /> : menu.error ? <ErrorText error={menu.error} /> :
        view === 'items' ? <ItemsView cats={menu.data ?? []} /> : <OptionsView cats={menu.data ?? []} />}
    </div>
  );
}

function Thumb({ src, name }: { src: string | null; name: string }) {
  const [bad, setBad] = useState(false);
  if (src && !bad) return <img src={src} alt="" loading="lazy" onError={() => setBad(true)} className="h-14 w-14 shrink-0 rounded-xl bg-[var(--panel-2)] object-cover" />;
  return <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-[var(--panel-2)] text-lg font-bold text-[var(--muted)]">{name.slice(0, 1)}</div>;
}

const sizesSummary = (i: MItem) => i.variants.length === 0 ? 'No sizes yet'
  : i.variants.map((v) => `${v.name}${v.enabled ? '' : ' (off)'} ${v.open_price ? 'any amount' : rs(v.price_minor)}`).join(' · ');

function ItemsView({ cats }: { cats: MCategory[] }) {
  const { orgId, location } = useScope();
  const toast = useToast();
  const refresh = useMenuRefresh();
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'all' | 'on' | 'off'>('all');
  const [editItem, setEditItem] = useState<{ id: string | null; categoryId?: string } | null>(null);
  const [editCat, setEditCat] = useState<MCategory | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try { await fn(); toast(msg); refresh(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'bad'); } finally { setBusy(null); }
  };
  const term = search.trim().toLowerCase();
  const allItems = cats.flatMap((c) => c.items);
  const onCount = allItems.filter((i) => i.enabled).length;

  return (
    <div className="space-y-4">
      <Note>
        The full menu is pre-loaded; most items start <b>off</b>. Switch on what you sell. {location && <>Use the <b>{location.name}</b> setting to sell an item only at some locations (switch locations at the top).</>}
      </Note>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="min-w-0 flex-1 sm:max-w-xs" placeholder="Search items…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select className="w-auto" value={show} onChange={(e) => setShow(e.target.value as typeof show)}
          options={[{ value: 'all', label: 'All items' }, { value: 'on', label: 'Switched on' }, { value: 'off', label: 'Switched off' }]} />
        <span className="text-sm text-[var(--muted)]">{onCount} of {allItems.length} on</span>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => setEditCat('new')}>Add category</Button>
          <Button variant="primary" disabled={cats.length === 0} onClick={() => setEditItem({ id: null })}>Add item</Button>
        </div>
      </div>
      {cats.length === 0 && <Empty>No categories yet. Add one to start.</Empty>}
      {cats.map((c) => {
        const items = c.items.filter((i) => (!term || i.name.toLowerCase().includes(term)) && (show === 'all' || (show === 'on') === i.enabled));
        if ((term || show !== 'all') && items.length === 0) return null;
        return (
          <Card key={c.id} title={<span className="flex items-center gap-2">{c.name}<Badge>{c.kind === 'beverage' ? 'Drinks' : 'Food'}</Badge>
            <span className="text-sm font-normal text-[var(--muted)]">{c.items.filter((i) => i.enabled).length}/{c.items.length} on</span></span>}
          actions={<div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditCat(c)}>Edit category</Button>
            <Button size="sm" onClick={() => setEditItem({ id: null, categoryId: c.id })}>Add item</Button>
          </div>}>
            {items.length === 0 ? <p className="text-sm text-[var(--muted)]">No items in this category.</p> : (
              <div className="divide-y divide-[var(--line)]">
                {items.map((i) => {
                  const here = i.location_enabled ?? i.enabled;
                  return (
                    <div key={i.id} className="flex flex-wrap items-center gap-3 py-3">
                      <Thumb src={i.image} name={i.name} />
                      <div className="min-w-0 flex-1 basis-48">
                        <div className="flex flex-wrap items-center gap-2 font-medium">
                          {i.name}{i.is_deal && <Badge tone="brand">Deal</Badge>}{i.modifierGroups.length > 0 && <Badge>Options</Badge>}
                        </div>
                        <div className="text-sm text-[var(--muted)]">{sizesSummary(i)}</div>
                      </div>
                      <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
                        <span className="flex items-center gap-2 text-sm">
                          <Toggle on={i.enabled} label={`${i.name} on the menu`} disabled={busy === i.id}
                            onChange={(v) => act(i.id, () => post(`/orgs/${orgId}/menu/items/${i.id}/enabled`, { enabled: v }), v ? `${i.name} switched on` : `${i.name} switched off`)} />
                          <span className="w-7">{i.enabled ? 'On' : 'Off'}</span>
                        </span>
                        {location && (
                          <label className="flex items-center gap-2 text-sm">
                            <span className="hidden text-[var(--muted)] lg:inline">{location.name}:</span>
                            <Select aria-label={`${i.name} at ${location.name}`} className="w-auto" disabled={busy === `${i.id}-loc`}
                              value={i.location_enabled === null ? 'follow' : i.location_enabled ? 'on' : 'off'}
                              onChange={(e) => {
                                const v = e.target.value;
                                void act(`${i.id}-loc`, () => post(`/orgs/${orgId}/menu/items/${i.id}/location`, { locationId: location.id, enabled: v === 'follow' ? null : v === 'on' }), `Saved for ${location.name}`);
                              }}
                              options={[
                                { value: 'follow', label: `Follow organization (${i.enabled ? 'on' : 'off'})` },
                                { value: 'on', label: `Always on at ${location.name}` },
                                { value: 'off', label: `Always off at ${location.name}` },
                              ]} />
                            <Badge tone={here ? 'good' : 'neutral'}>{here ? 'Sold here' : 'Not sold here'}</Badge>
                          </label>
                        )}
                        <Button size="sm" onClick={() => setEditItem({ id: i.id })}>Edit</Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
      {editItem && <ItemModal key={editItem.id ?? 'new'} initialId={editItem.id} categoryId={editItem.categoryId} cats={cats} onClose={() => setEditItem(null)} />}
      {editCat && <CategoryModal key={editCat === 'new' ? 'new' : editCat.id} cat={editCat === 'new' ? null : editCat} onClose={() => setEditCat(null)} />}
    </div>
  );
}

function CategoryModal({ cat, onClose }: { cat: MCategory | null; onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const refresh = useMenuRefresh();
  const [name, setName] = useState(cat?.name ?? '');
  const [kind, setKind] = useState<'food' | 'beverage'>(cat?.kind ?? 'food');
  const [sort, setSort] = useState(String(cat?.sort ?? 0));
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/menu/categories`, { id: cat?.id, name: name.trim(), kind, sort: Number.parseInt(sort, 10) || 0 }),
    onSuccess: () => { toast('Category saved'); refresh(); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={cat ? `Edit ${cat.name}` : 'Add a category'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!name.trim()} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Loaded fries" /></Field>
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'food' | 'beverage')} options={[{ value: 'food', label: 'Food' }, { value: 'beverage', label: 'Drinks' }]} />
        </Field>
        <Field label="Order on the menu" hint="Lower numbers come first."><Input inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} /></Field>
        <div className="sm:col-span-2"><ErrorText error={save.error} /></div>
      </div>
    </Modal>
  );
}

function ItemModal({ initialId, categoryId, cats, onClose }: { initialId: string | null; categoryId?: string; cats: MCategory[]; onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const refresh = useMenuRefresh();
  const [itemId, setItemId] = useState(initialId);
  const item = itemId ? cats.flatMap((c) => c.items).find((i) => i.id === itemId) ?? null : null;
  const [d, setD] = useState(() => ({
    name: item?.name ?? '', description: item?.description ?? '', image: item?.image ?? '',
    categoryId: item?.category_id ?? categoryId ?? cats[0]?.id ?? '', enabled: item?.enabled ?? false, isDeal: item?.is_deal ?? false,
  }));
  const [drafts, setDrafts] = useState<number[]>(() => (initialId ? [] : [1]));
  const saveDetails = useMutation({
    mutationFn: () => post<{ id: string }>(`/orgs/${orgId}/menu/items`, {
      id: itemId ?? undefined, categoryId: d.categoryId, name: d.name.trim(), description: d.description.trim() || null,
      image: d.image.trim() || null, enabled: item ? item.enabled : d.enabled, isDeal: d.isDeal,
    }),
    onSuccess: (r) => { toast(itemId ? 'Item saved' : 'Item added — now add its sizes'); setItemId(r.id); refresh(); },
  });
  // Every size on the menu that is not itself a deal, for building deals.
  const componentOptions = cats.flatMap((c) => c.items.filter((i) => !i.is_deal).flatMap((i) => i.variants.map((v) => ({ value: v.id, label: `${i.name} — ${v.name}` }))));

  return (
    <Modal open wide onClose={onClose} title={itemId ? `Edit ${item?.name ?? 'item'}` : 'Add an item'} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-5">
        <section className="space-y-3">
          <h3 className="font-semibold">Details</h3>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
              <Field label="Category">
                <Select value={d.categoryId} onChange={(e) => setD({ ...d, categoryId: e.target.value })} options={cats.map((c) => ({ value: c.id, label: c.name }))} />
              </Field>
              <Field label="Description" className="sm:col-span-2"><Textarea value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
              <Field label="Picture" className="sm:col-span-2" hint="Image path or link, e.g. /menu/masala-fries.jpg">
                <Input value={d.image} onChange={(e) => setD({ ...d, image: e.target.value })} placeholder="/menu/…" />
              </Field>
            </div>
            <div className="hidden sm:block"><Thumb key={d.image} src={d.image.trim() || null} name={d.name || '?'} /></div>
          </div>
          <div className="flex flex-wrap gap-x-6">
            {!itemId && <Check checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })}>Switch on now</Check>}
            <Check checked={d.isDeal} onChange={(v) => setD({ ...d, isDeal: v })}>This is a deal (a bundle of other items)</Check>
          </div>
          <ErrorText error={saveDetails.error} />
          <Button variant="primary" disabled={!d.name.trim() || !d.categoryId} busy={saveDetails.isPending} onClick={() => saveDetails.mutate()}>
            {itemId ? 'Save details' : 'Add item'}
          </Button>
        </section>

        {itemId && (
          <section className="space-y-3 border-t border-[var(--line)] pt-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Sizes &amp; prices</h3>
              <Button size="sm" onClick={() => setDrafts((x) => [...x, Date.now()])}>Add a size</Button>
            </div>
            <p className="text-sm text-[var(--muted)]">Each size is what the cashier taps. Use “custom amount” for things sold by the rupee (e.g. “Rs 300 of fries”).</p>
            {!item ? <Loading /> : (
              <>
                {item.variants.map((v) => <VariantRow key={v.id} itemId={item.id} v={v} isDeal={item.is_deal} componentOptions={componentOptions} />)}
                {drafts.map((k) => <VariantRow key={k} itemId={item.id} v={null} isDeal={item.is_deal} componentOptions={componentOptions}
                  onDone={() => setDrafts((x) => x.filter((y) => y !== k))} />)}
                {item.variants.length === 0 && drafts.length === 0 && <Empty>No sizes yet. An item needs at least one size to be sold.</Empty>}
              </>
            )}
          </section>
        )}

        {item && item.modifierGroups.length > 0 && (
          <section className="border-t border-[var(--line)] pt-4 text-sm">
            <h3 className="mb-1 font-semibold">Add-on options</h3>
            <p className="text-[var(--muted)]">{item.modifierGroups.map((g) => g.name).join(', ')} — edit these under “Add-on options”.</p>
          </section>
        )}
      </div>
    </Modal>
  );
}

function VariantRow({ itemId, v, isDeal, componentOptions, onDone }: {
  itemId: string; v: MVariant | null; isDeal: boolean; componentOptions: { value: string; label: string }[]; onDone?: () => void;
}) {
  const { orgId } = useScope();
  const toast = useToast();
  const refresh = useMenuRefresh();
  const [name, setName] = useState(v?.name ?? 'Regular');
  const [sizeTag, setSizeTag] = useState(v?.size_tag ?? '');
  const [price, setPrice] = useState<number | null>(v?.price_minor ?? null);
  const [openPrice, setOpenPrice] = useState(v?.open_price ?? false);
  const [basis, setBasis] = useState<number | null>(v?.recipe_basis_minor ?? null);
  const [enabled, setEnabled] = useState(v?.enabled ?? true);
  const dirty = !v || name !== v.name || sizeTag !== (v.size_tag ?? '') || price !== v.price_minor || openPrice !== v.open_price
    || (openPrice && basis !== v.recipe_basis_minor) || enabled !== v.enabled;
  const valid = name.trim().length > 0 && (openPrice ? !!basis && basis > 0 : price !== null);
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/menu/variants`, {
      id: v?.id, menuItemId: itemId, name: name.trim(), sizeTag: sizeTag.trim() || null, priceMinor: openPrice ? price ?? 0 : price,
      openPrice, recipeBasisMinor: openPrice ? basis : null, enabled,
    }),
    onSuccess: () => { toast(v ? 'Size saved' : 'Size added'); refresh(); onDone?.(); },
  });
  return (
    <div className={cx('rounded-xl border border-[var(--line)] p-3', !enabled && 'opacity-80')}>
      <div className="grid gap-2 sm:grid-cols-[1fr_130px_160px]">
        <Field label="Size name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Large" /></Field>
        <Field label="Size tag"><Input value={sizeTag} onChange={(e) => setSizeTag(e.target.value)} placeholder="e.g. L" /></Field>
        {openPrice
          ? <Field label="Recipe is for" hint="Stock use scales from this amount."><MoneyInput value={basis} onChange={setBasis} /></Field>
          : <Field label="Price"><MoneyInput value={price} onChange={setPrice} /></Field>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
        <Check checked={openPrice} onChange={setOpenPrice}>Custom amount (customer says how much)</Check>
        <Check checked={enabled} onChange={setEnabled}>On sale</Check>
        {v && (v.has_recipe ? <Badge tone="good">{isDeal ? 'Contents set' : 'Recipe set'}</Badge> : <Badge tone="warn">{isDeal ? 'No contents yet' : 'No recipe yet'}</Badge>)}
        <div className="ml-auto flex gap-2">
          {!v && <Button size="sm" variant="ghost" onClick={onDone}>Remove</Button>}
          <Button size="sm" variant="primary" disabled={!dirty || !valid} busy={save.isPending} onClick={() => save.mutate()}>{v ? 'Save size' : 'Add size'}</Button>
        </div>
      </div>
      <ErrorText error={save.error} />
      {v && isDeal && <DealEditor variant={v} options={componentOptions} />}
    </div>
  );
}

function DealEditor({ variant, options }: { variant: MVariant; options: { value: string; label: string }[] }) {
  const { orgId } = useScope();
  const toast = useToast();
  const refresh = useMenuRefresh();
  const [rows, setRows] = useState(() => variant.components.map((c) => ({ variantId: c.variantId, qty: String(c.qty) })));
  const valid = rows.every((r) => r.variantId && /^[1-9]\d*$/.test(r.qty));
  const save = useMutation({
    mutationFn: () => put(`/orgs/${orgId}/menu/variants/${variant.id}/deal`, { components: rows.map((r) => ({ variantId: r.variantId, qty: Number(r.qty) })) }),
    onSuccess: () => { toast('Deal contents saved'); refresh(); },
  });
  return (
    <div className="mt-3 space-y-2 rounded-xl bg-[var(--panel-2)] p-3">
      <div className="text-sm font-medium">What's in this deal ({variant.name})</div>
      {rows.length === 0 && <p className="text-sm text-[var(--muted)]">Nothing yet. Add the items that make up the deal so stock is used correctly.</p>}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_72px_auto] gap-2">
          <Select value={r.variantId} placeholder="Pick an item and size" options={options} aria-label="Deal item"
            onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, variantId: e.target.value } : y)))} />
          <Input inputMode="numeric" aria-label="How many" value={r.qty} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)))} />
          <Button variant="ghost" aria-label="Remove" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>✕</Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setRows((x) => [...x, { variantId: '', qty: '1' }])}>Add item to deal</Button>
        <Button size="sm" variant="primary" disabled={!valid} busy={save.isPending} onClick={() => save.mutate()}>Save contents</Button>
      </div>
      <ErrorText error={save.error} />
    </div>
  );
}

interface GroupInfo { g: MGroup; itemIds: string[] }

function OptionsView({ cats }: { cats: MCategory[] }) {
  const [editing, setEditing] = useState<GroupInfo | 'new' | null>(null);
  const items = cats.flatMap((c) => c.items);
  const groups = useMemo(() => {
    const m = new Map<string, GroupInfo>();
    for (const i of items) for (const g of i.modifierGroups) {
      const e = m.get(g.id) ?? { g, itemIds: [] };
      e.itemIds.push(i.id);
      m.set(g.id, e);
    }
    return [...m.values()].sort((a, b) => a.g.name.localeCompare(b.g.name));
  }, [items]);
  const itemName = (id: string) => items.find((i) => i.id === id)?.name ?? '?';
  return (
    <div className="space-y-4">
      <Note>
        Add-on options change the price of an item, e.g. “Extra cheese +Rs 80” or “Sauce” (pick up to 2). Each group is linked to the items that offer it.
      </Note>
      <div className="flex justify-end"><Button variant="primary" onClick={() => setEditing('new')}>New option group</Button></div>
      {groups.length === 0 ? <Empty>No option groups yet.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2">
          {groups.map(({ g, itemIds }) => (
            <div key={g.id} className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{g.name}</div>
                  <div className="text-sm text-[var(--muted)]">
                    {g.min_select > 0 ? `Must pick ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`}` : `Optional, up to ${g.max_select}`}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ g, itemIds })}>Edit</Button>
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {g.modifiers.map((m) => (
                  <li key={m.id} className="flex justify-between gap-2">
                    <span className={cx(!m.enabled && 'text-[var(--muted)] line-through')}>{m.name}</span>
                    <span className="tabular">{m.price_delta_minor === 0 ? 'free' : rs(m.price_delta_minor, { sign: true })}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-[var(--muted)]">Used by: {itemIds.map(itemName).join(', ')}</div>
            </div>
          ))}
        </div>
      )}
      {editing && <GroupModal key={editing === 'new' ? 'new' : editing.g.id} info={editing === 'new' ? null : editing} cats={cats} onClose={() => setEditing(null)} />}
    </div>
  );
}

function GroupModal({ info, cats, onClose }: { info: GroupInfo | null; cats: MCategory[]; onClose: () => void }) {
  const { orgId } = useScope();
  const toast = useToast();
  const refresh = useMenuRefresh();
  const g = info?.g;
  const [name, setName] = useState(g?.name ?? '');
  const [min, setMin] = useState(String(g?.min_select ?? 0));
  const [max, setMax] = useState(String(g?.max_select ?? 1));
  const [mods, setMods] = useState(() => (g?.modifiers ?? []).map((m) => ({
    id: m.id as string | undefined, name: m.name, sign: m.price_delta_minor < 0 ? -1 : 1, amount: Math.abs(m.price_delta_minor) as number | null, enabled: m.enabled,
  })));
  const [itemIds, setItemIds] = useState<string[]>(info?.itemIds ?? []);
  const [filter, setFilter] = useState('');
  const minN = Number.parseInt(min, 10);
  const maxN = Number.parseInt(max, 10);
  const valid = name.trim() && minN >= 0 && maxN >= 1 && minN <= maxN && mods.length > 0 && mods.every((m) => m.name.trim() && m.amount !== null) && itemIds.length > 0;
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/menu/modifier-groups`, {
      id: g?.id, name: name.trim(), minSelect: minN, maxSelect: maxN, itemIds,
      modifiers: mods.map((m) => ({ id: m.id, name: m.name.trim(), priceDeltaMinor: m.sign * (m.amount ?? 0), enabled: m.enabled })),
    }),
    onSuccess: () => { toast('Options saved'); refresh(); onClose(); },
  });
  const setMod = (i: number, patchMod: Partial<(typeof mods)[number]>) => setMods((x) => x.map((y, j) => (j === i ? { ...y, ...patchMod } : y)));
  const term = filter.trim().toLowerCase();
  return (
    <Modal open wide onClose={onClose} title={g ? `Edit ${g.name}` : 'New option group'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!valid} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
    </>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_120px_120px]">
          <Field label="Group name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Extra toppings" /></Field>
          <Field label="Must pick at least" hint="0 = optional"><Input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
          <Field label="Can pick up to"><Input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">Options</div>
          {mods.map((m, i) => (
            <div key={m.id ?? `new-${i}`} className="grid grid-cols-[1fr_auto] gap-2 rounded-xl border border-[var(--line)] p-2 sm:grid-cols-[1fr_80px_150px_auto]">
              <Input value={m.name} aria-label="Option name" placeholder="e.g. Extra cheese" onChange={(e) => setMod(i, { name: e.target.value })} />
              <Select className="sm:order-none" aria-label="Adds or takes off" value={String(m.sign)} onChange={(e) => setMod(i, { sign: Number(e.target.value) })}
                options={[{ value: '1', label: '+ add' }, { value: '-1', label: '− off' }]} />
              <MoneyInput value={m.amount} onChange={(v) => setMod(i, { amount: v })} aria-label="Price change" />
              {m.id ? <Check checked={m.enabled} onChange={(v) => setMod(i, { enabled: v })} className="items-center">On</Check>
                : <Button variant="ghost" aria-label="Remove" onClick={() => setMods((x) => x.filter((_, j) => j !== i))}>✕</Button>}
            </div>
          ))}
          <Button size="sm" onClick={() => setMods((x) => [...x, { id: undefined, name: '', sign: 1, amount: 0, enabled: true }])}>Add option</Button>
          <p className="text-xs text-[var(--muted)]">Saved options can be switched off but not deleted, so old sales keep their names.</p>
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">Offered on these items ({itemIds.length})</div>
            <Input className="h-9 w-48" placeholder="Find item…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-xl border border-[var(--line)] p-3">
            {cats.map((c) => {
              const list = c.items.filter((i) => !term || i.name.toLowerCase().includes(term));
              if (list.length === 0) return null;
              return (
                <div key={c.id} className="mb-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{c.name}</div>
                  <div className="grid sm:grid-cols-2">
                    {list.map((i) => (
                      <Check key={i.id} checked={itemIds.includes(i.id)}
                        onChange={(v) => setItemIds((x) => (v ? [...x, i.id] : x.filter((y) => y !== i.id)))}>
                        {i.name}{!i.enabled && <span className="text-[var(--muted)]"> (off)</span>}
                      </Check>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-[var(--muted)]">Tick at least one item. A group not used by any item is hidden from this list.</p>
        </div>
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

const pct = (bps: number) => `${(bps / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}%`;

function TaxesView() {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const taxes = useQuery({ queryKey: ['taxes', orgId], queryFn: () => get<Tax[]>(`/orgs/${orgId}/taxes`) });
  const [editing, setEditing] = useState<Tax | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (taxes.isLoading) return <Loading />;
  if (taxes.error) return <ErrorText error={taxes.error} />;
  const flip = async (t: Tax, enabled: boolean) => {
    setBusy(t.id);
    try {
      await post(`/orgs/${orgId}/taxes`, { id: t.id, name: t.name, rateBps: t.rate_bps, appliesTo: t.applies_to, inclusive: t.inclusive, enabled });
      toast(enabled ? `${t.name} on` : `${t.name} off`);
      void qc.invalidateQueries({ queryKey: ['taxes'] });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'bad');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-4">
      <Note>Taxes and fees are worked out on each sale. “Included” means menu prices already contain it; “added” puts it on top.</Note>
      <div className="flex justify-end"><Button variant="primary" onClick={() => setEditing('new')}>Add tax or fee</Button></div>
      {(taxes.data ?? []).length === 0 ? <Empty>No taxes or fees. Sales are charged at menu price.</Empty> : (
        <div className="space-y-2">
          {taxes.data!.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t.name} <span className="tabular">{pct(t.rate_bps)}</span></div>
                <div className="text-sm text-[var(--muted)]">
                  {t.applies_to === 'all' ? 'All sales' : 'Card / digital payments only'} · {t.inclusive ? 'included in prices' : 'added on top'}
                </div>
              </div>
              <Toggle on={t.enabled} label={`${t.name} on`} disabled={busy === t.id} onChange={(v) => flip(t, v)} />
              <Button size="sm" onClick={() => setEditing(t)}>Edit</Button>
            </div>
          ))}
        </div>
      )}
      {editing && <TaxModal key={editing === 'new' ? 'new' : editing.id} tax={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TaxModal({ tax, onClose }: { tax: Tax | null; onClose: () => void }) {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(tax?.name ?? '');
  const [rate, setRate] = useState(tax ? String(tax.rate_bps / 100) : '');
  const [appliesTo, setAppliesTo] = useState<'all' | 'card'>(tax?.applies_to ?? 'all');
  const [inclusive, setInclusive] = useState(tax?.inclusive ?? true);
  const [enabled, setEnabled] = useState(tax?.enabled ?? true);
  const rateOk = /^\d{1,3}(\.\d{1,2})?$/.test(rate.trim()) && Number(rate) <= 100;
  const save = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/taxes`, { id: tax?.id, name: name.trim(), rateBps: Math.round(Number(rate) * 100), appliesTo, inclusive, enabled }),
    onSuccess: () => { toast('Saved'); void qc.invalidateQueries({ queryKey: ['taxes'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={tax ? `Edit ${tax.name}` : 'Add tax or fee'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!name.trim() || !rateOk} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales tax, Card fee" /></Field>
        <Field label="Rate (%)" hint={rate && !rateOk ? 'Use a number from 0 to 100, up to 2 decimals.' : undefined}>
          <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 16" />
        </Field>
        <Field label="Applies to">
          <Select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as 'all' | 'card')}
            options={[{ value: 'all', label: 'All sales' }, { value: 'card', label: 'Card / digital payments only' }]} />
        </Field>
        <Field label="How it's charged">
          <Select value={inclusive ? 'in' : 'out'} onChange={(e) => setInclusive(e.target.value === 'in')}
            options={[{ value: 'in', label: 'Included in menu prices' }, { value: 'out', label: 'Added on top of the bill' }]} />
        </Field>
        <Check checked={enabled} onChange={setEnabled} className="sm:col-span-2">Switched on</Check>
        <div className="sm:col-span-2"><ErrorText error={save.error} /></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Notification rules

interface OrgNotif { type: string; label: string; who: string; enabled: boolean; config: Record<string, unknown> }

function NotificationRulesTab() {
  const { orgId, org } = useScope();
  const rules = useQuery({ queryKey: ['notification-settings', orgId], queryFn: () => get<OrgNotif[]>(`/orgs/${orgId}/notification-settings`) });
  if (rules.isLoading) return <Loading />;
  if (rules.error) return <ErrorText error={rules.error} />;
  return (
    <div className="space-y-4">
      <Note>
        Every alert has a clear rule for who gets it. Switching one off here stops it for everyone in {org.brand_name}; each person can also mute
        alerts for themselves under My account. Times are in {org.timezone}.
      </Note>
      <div className="space-y-2">{(rules.data ?? []).map((r) => <RuleRow key={r.type} rule={r} />)}</div>
    </div>
  );
}

function RuleRow({ rule }: { rule: OrgNotif }) {
  const { orgId } = useScope();
  const qc = useQueryClient();
  const toast = useToast();
  const [cfg, setCfg] = useState<Record<string, unknown>>(rule.config);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(rule.config);
  const save = useMutation({
    mutationFn: (b: { enabled: boolean; config: Record<string, unknown> }) => post(`/orgs/${orgId}/notification-settings`, { type: rule.type, ...b }),
    onSuccess: () => { toast('Saved'); void qc.invalidateQueries({ queryKey: ['notification-settings'] }); },
    onError: (e) => toast(e.message, 'bad'),
  });
  const num = (k: string) => (typeof cfg[k] === 'number' ? String(cfg[k]) : String(cfg[k] ?? ''));
  const hoursOk = (k: string) => !(k in cfg) || (Number.isInteger(Number(cfg[k])) && Number(cfg[k]) >= 1 && Number(cfg[k]) <= 168);
  const timeOk = !('time' in cfg) || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(cfg.time));
  const valid = timeOk && hoursOk('everyHours') && hoursOk('afterHours');
  const hasConfig = ['time', 'everyHours', 'afterHours'].some((k) => k in rule.config);
  return (
    <div className={cx('rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3', !rule.enabled && 'opacity-80')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{rule.label}</div>
          <div className="text-sm text-[var(--muted)]">Goes to: {rule.who}</div>
        </div>
        <Toggle on={rule.enabled} label={`${rule.label} on`} disabled={save.isPending} onChange={(v) => save.mutate({ enabled: v, config: rule.config })} />
      </div>
      {hasConfig && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {'time' in rule.config && (
            <Field label="Send at" className="w-36"><Input type="time" value={String(cfg.time ?? '')} onChange={(e) => setCfg({ ...cfg, time: e.target.value })} /></Field>
          )}
          {'everyHours' in rule.config && (
            <Field label="Repeat every (hours)" className="w-44">
              <Input inputMode="numeric" value={num('everyHours')} onChange={(e) => setCfg({ ...cfg, everyHours: e.target.value === '' ? '' : Number(e.target.value) })} />
            </Field>
          )}
          {'afterHours' in rule.config && (
            <Field label="Follow up after (hours)" className="w-48">
              <Input inputMode="numeric" value={num('afterHours')} onChange={(e) => setCfg({ ...cfg, afterHours: e.target.value === '' ? '' : Number(e.target.value) })} />
            </Field>
          )}
          {dirty && <Button variant="primary" disabled={!valid} busy={save.isPending} onClick={() => save.mutate({ enabled: rule.enabled, config: cfg })}>Save</Button>}
          {dirty && <Button variant="ghost" onClick={() => setCfg(rule.config)}>Undo</Button>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Audit trail

interface AuditRow {
  id: string | number; at: string; action: string; entity_type: string; entity_id: string | null; before: unknown; after: unknown; ip: string | null; actor: string;
}

const ACTION_PREFIXES = ['auth.', 'user.', 'person.', 'role.', 'permission.', 'location.', 'org.', 'menu.', 'tax.', 'day.', 'order.', 'expense.', 'purchase.', 'approval.', 'owner.'];

const fullTime = (d: string) => new Date(d).toLocaleString('en-PK', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

function AuditTab() {
  const { orgId } = useScope();
  const empty = { action: '', entityType: '', entityId: '', limit: '200' };
  const [draft, setDraft] = useState(empty);
  const [filters, setFilters] = useState(empty);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['audit', orgId, filters],
    queryFn: () => get<AuditRow[]>(`/orgs/${orgId}/audit${qs({ action: filters.action.trim(), entityType: filters.entityType.trim(), entityId: filters.entityId.trim(), limit: filters.limit })}`),
  });
  const types = [...new Set((q.data ?? []).map((r) => r.entity_type))].sort();
  const apply = (f: typeof empty) => { setDraft(f); setFilters(f); setOpen(null); };
  const active = filters.action || filters.entityType || filters.entityId;
  return (
    <div className="space-y-4">
      <Note>
        The audit trail is <b>unchangeable</b>: nobody, not even an administrator, can edit or delete it. Each entry is chained to the one before,
        so any tampering shows up in the platform health check.
      </Note>
      <Card>
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_120px_auto]" onSubmit={(e) => { e.preventDefault(); apply(draft); }}>
          <Field label="Action starts with">
            <Input list="audit-actions" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} placeholder="e.g. user." />
          </Field>
          <Field label="Record type">
            <Input list="audit-types" value={draft.entityType} onChange={(e) => setDraft({ ...draft, entityType: e.target.value })} placeholder="e.g. menu_item" />
          </Field>
          <Field label="Record id"><Input value={draft.entityId} onChange={(e) => setDraft({ ...draft, entityId: e.target.value })} /></Field>
          <Field label="Show">
            <Select value={draft.limit} onChange={(e) => setDraft({ ...draft, limit: e.target.value })}
              options={['50', '200', '500', '1000'].map((n) => ({ value: n, label: `Last ${n}` }))} />
          </Field>
          <div className="flex items-end gap-2">
            <Button variant="primary" type="submit">Search</Button>
            {active && <Button type="button" variant="ghost" onClick={() => apply(empty)}>Clear</Button>}
          </div>
          <datalist id="audit-actions">{ACTION_PREFIXES.map((a) => <option key={a} value={a} />)}</datalist>
          <datalist id="audit-types">{types.map((t) => <option key={t} value={t} />)}</datalist>
        </form>
      </Card>
      {q.isLoading ? <Loading /> : q.error ? <ErrorText error={q.error} /> : (q.data ?? []).length === 0 ? <Empty>No entries match.</Empty> : (
        <div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)]">
          <div className="hidden grid-cols-[190px_150px_1fr_1fr_24px] gap-3 border-b border-[var(--line)] px-4 py-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)] md:grid">
            <span>When</span><span>Who</span><span>Action</span><span>Record</span><span />
          </div>
          {q.data!.map((r) => {
            const key = String(r.id);
            const isOpen = open === key;
            return (
              <div key={key} className="border-b border-[var(--line)] last:border-0">
                <button onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}
                  className="grid w-full grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-4 py-3 text-left text-sm hover:bg-[var(--panel-2)] md:grid-cols-[190px_150px_1fr_1fr_24px]">
                  <span className="tabular text-[var(--muted)] md:text-[var(--ink)]">{fullTime(r.at)}</span>
                  <span className="text-right font-medium md:text-left">{r.actor}</span>
                  <span className="font-mono text-xs leading-5">{r.action}</span>
                  <span className="truncate text-right text-[var(--muted)] md:text-left">{r.entity_type}{r.entity_id ? ` · ${r.entity_id.slice(0, 8)}` : ''}</span>
                  <span className="hidden text-[var(--muted)] md:block">{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && (
                  <div className="space-y-3 bg-[var(--panel-2)] px-4 py-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
                      <span>Entry #{key}</span>
                      {r.entity_id && <span className="break-all">Record id {r.entity_id}</span>}
                      {r.ip && <span>From {r.ip}</span>}
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <JsonBlock label="Before" value={r.before} />
                      <JsonBlock label="After" value={r.after} />
                    </div>
                    {r.entity_id && (
                      <Button size="sm" onClick={() => apply({ ...empty, limit: filters.limit, entityType: r.entity_type, entityId: r.entity_id! })}>
                        Show full history of this record
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{label}</div>
      {value === null || value === undefined ? <div className="text-sm text-[var(--muted)]">—</div> : (
        <pre className="max-h-80 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>
      )}
    </div>
  );
}
