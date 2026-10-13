import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, get, post } from '../api';
import { Badge, Button, Card, ErrorText, Input, Loading, PageHeader, useToast } from '../components/ui';
import { useSession } from '../session';
import { copyText, Toggle } from './Admin';
import { ChangePassword } from './Auth';
import { InstallSteps } from './Install';

// "My account": who I am, my password, two-factor, my alerts, push on this device, installing the app.

export function Settings() {
  const s = useSession();
  const me = s.me!;
  return (
    <>
      <PageHeader title="My account" sub="Your sign-in, security and alerts." />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="Who you are">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-[var(--muted)]">Name</dt><dd className="font-medium">{me.user.displayName}</dd>
              <dt className="text-[var(--muted)]">Username</dt><dd className="font-mono">{me.user.username}</dd>
              {s.org && <><dt className="text-[var(--muted)]">Working in</dt><dd>{s.org.brand_name}{s.location ? ` · ${s.location.name}` : ''}</dd></>}
              {me.user.isPlatformOwner && <><dt className="text-[var(--muted)]">Role</dt><dd><Badge tone="brand">Platform owner</Badge></dd></>}
            </dl>
            {s.org && (
              <p className="mt-3 text-xs text-[var(--muted)]">
                You have {s.org.permissions.length} right{s.org.permissions.length === 1 ? '' : 's'} in {s.org.brand_name}. An administrator manages these.
              </p>
            )}
          </Card>
          <Card title="Change password"><ChangePassword /></Card>
          <TwoFactor />
        </div>
        <div className="space-y-4">
          <PushCard />
          <MyAlerts />
          <Card title="Install the app"><InstallSteps /></Card>
        </div>
      </div>
    </>
  );
}

// ---- Two-factor ----

function TwoFactor() {
  const s = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const userId = s.me!.user.userId;
  // /auth/me does not say whether 2FA is on; administrators can see it from the user list.
  const canSee = s.can('users.manage') && !!s.org;
  const users = useQuery({
    queryKey: ['admin-users', s.org?.id],
    queryFn: () => get<{ id: string; totp_enabled: boolean }[]>(`/orgs/${s.org!.id}/users`),
    enabled: canSee,
  });
  const knownOn = users.data?.find((u) => u.id === userId)?.totp_enabled;
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const [alreadyOn, setAlreadyOn] = useState(false);
  const begin = useMutation({ mutationFn: () => post<{ secret: string; uri: string }>('/auth/totp/begin'), onSuccess: (r) => { setSetup(r); setCode(''); } });
  const enable = useMutation({
    mutationFn: () => post('/auth/totp/enable', { code: code.replace(/\s/g, '') }),
    onSuccess: () => { setDone(true); setSetup(null); toast('Two-factor sign-in is on'); void qc.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'totp_enabled') { setAlreadyOn(true); setSetup(null); } },
  });
  const isOn = done || alreadyOn || knownOn === true;
  const grouped = setup ? setup.secret.replace(/\s/g, '').match(/.{1,4}/g)?.join(' ') ?? setup.secret : '';
  const submit = (e: FormEvent) => { e.preventDefault(); if (/^\d{6,8}$/.test(code.replace(/\s/g, ''))) enable.mutate(); };

  return (
    <Card title="Two-factor sign-in" actions={isOn ? <Badge tone="good">On</Badge> : knownOn === false ? <Badge tone="warn">Off</Badge> : null}>
      {isOn ? (
        <p className="text-sm">
          Two-factor is on. When you sign in on a new device you'll enter the 6-digit code from your authenticator app.
          {' '}Lost your phone? Ask an administrator to help you reset it.
        </p>
      ) : !setup ? (
        <div className="space-y-3 text-sm">
          <p>Add a second step to signing in: a 6-digit code from an authenticator app on your phone. Strongly recommended for partners and administrators.</p>
          <ErrorText error={begin.error} />
          <Button variant="primary" busy={begin.isPending} onClick={() => begin.mutate()}>Set up two-factor</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4 text-sm">
          <ol className="list-decimal space-y-3 pl-5">
            <li>Install an authenticator app, e.g. <b>Google Authenticator</b> or <b>Microsoft Authenticator</b>.</li>
            <li>
              In the app, choose <b>Enter a setup key</b>. Account: <b className="font-mono">{s.me!.user.username}</b>, key type <b>Time based</b>. Key:
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="select-all break-all rounded-lg bg-[var(--panel-2)] px-3 py-2 font-mono text-base tracking-wider">{grouped}</code>
                <Button size="sm" type="button" onClick={async () => {
                  const ok = await copyText(setup.secret);
                  toast(ok ? 'Key copied' : 'Could not copy', ok ? 'good' : 'bad');
                }}>Copy key</Button>
              </div>
              <div className="mt-2 text-[var(--muted)]">
                On this phone? <a href={setup.uri} className="font-medium text-[var(--ink)] underline">Open in authenticator app</a>
                <details className="mt-1">
                  <summary className="cursor-pointer">Show setup link</summary>
                  <code className="mt-1 block select-all break-all rounded-lg bg-[var(--panel-2)] p-2 text-xs">{setup.uri}</code>
                </details>
              </div>
            </li>
            <li>
              Type the 6-digit code the app shows:
              <div className="mt-2 flex flex-wrap gap-2">
                <Input className="w-40 text-center font-mono text-lg tracking-widest" inputMode="numeric" autoComplete="one-time-code" maxLength={8}
                  value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" aria-label="6-digit code" />
                <Button variant="primary" type="submit" busy={enable.isPending} disabled={!/^\d{6,8}$/.test(code.replace(/\s/g, ''))}>Turn on</Button>
              </div>
            </li>
          </ol>
          <ErrorText error={enable.error} />
          <Button type="button" variant="ghost" size="sm" onClick={() => setSetup(null)}>Cancel</Button>
        </form>
      )}
    </Card>
  );
}

// ---- My alerts ----

interface Pref { type: string; label: string; who: string; enabled: boolean }

function MyAlerts() {
  const qc = useQueryClient();
  const toast = useToast();
  const prefs = useQuery({ queryKey: ['notification-prefs'], queryFn: () => get<Pref[]>('/notifications/prefs') });
  const set = useMutation({
    mutationFn: (v: { type: string; enabled: boolean }) => post('/notifications/prefs', v),
    onMutate: (v) => {
      qc.setQueryData<Pref[]>(['notification-prefs'], (old) => old?.map((p) => (p.type === v.type ? { ...p, enabled: v.enabled } : p)));
    },
    onError: (e) => { toast(e.message, 'bad'); void qc.invalidateQueries({ queryKey: ['notification-prefs'] }); },
  });
  return (
    <Card title="My alerts">
      <p className="mb-3 text-sm text-[var(--muted)]">
        Choose which alerts you get. You only receive an alert when you're the person it goes to; your administrator can also switch an alert off for everyone.
      </p>
      {prefs.isLoading ? <Loading /> : prefs.error ? <ErrorText error={prefs.error} /> : (
        <div className="divide-y divide-[var(--line)]">
          {(prefs.data ?? []).map((p) => (
            <div key={p.type} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">{p.label}</div>
                <div className="text-xs text-[var(--muted)]">Goes to: {p.who}</div>
              </div>
              <Toggle on={p.enabled} label={p.label} onChange={(v) => set.mutate({ type: p.type, enabled: v })} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---- Push on this device ----

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

type PushState = 'checking' | 'unsupported' | 'blocked' | 'off' | 'on';

function PushCard() {
  const toast = useToast();
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [state, setState] = useState<PushState>(supported ? 'checking' : 'unsupported');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let gone = false;
    (async () => {
      if (Notification.permission === 'denied') return setState('blocked');
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!gone) setState(sub && Notification.permission === 'granted' ? 'on' : 'off');
    })().catch(() => !gone && setState('off'));
    return () => { gone = true; };
  }, [supported]);

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    setNotConfigured(false);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off');
        return;
      }
      const { publicKey } = await get<{ publicKey: string | null }>('/push/key');
      if (!publicKey) {
        setNotConfigured(true);
        return;
      }
      const reg = await withTimeout(navigator.serviceWorker.ready, 10_000, 'The app is still installing its background worker. Reload the page and try again.');
      const existing = await reg.pushManager.getSubscription();
      const sub = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('This browser gave an incomplete push subscription.');
      await post('/push/subscribe', { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      setState('on');
      toast('Push notifications are on for this device');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Notifications on this device" actions={state === 'on' ? <Badge tone="good">On</Badge> : state === 'blocked' ? <Badge tone="bad">Blocked</Badge> : null}>
      <div className="space-y-3 text-sm">
        {state === 'unsupported' && (
          <p>This browser can't receive push notifications. Install K-BAY to your home screen (below) using Chrome, then come back here.</p>
        )}
        {state === 'blocked' && (
          <p>Notifications are blocked for K-BAY. Open your browser's site settings (the lock icon next to the address, or the app's info page), allow notifications, then reload.</p>
        )}
        {(state === 'off' || state === 'checking' || state === 'on') && (
          <p>
            {state === 'on'
              ? 'This phone or tablet will buzz for approvals, reminders and questions, even when the app is closed.'
              : 'Get approvals, reminders and questions as phone notifications, even when the app is closed.'}
          </p>
        )}
        {notConfigured && (
          <p className="rounded-xl bg-amber-500/15 p-3">
            Push is not configured on the server yet. You'll still see every alert under the 🔔 bell in the app.
          </p>
        )}
        <ErrorText error={error} />
        {state !== 'unsupported' && state !== 'blocked' && (
          <Button variant={state === 'on' ? 'secondary' : 'primary'} busy={busy} disabled={state === 'checking'} onClick={turnOn}>
            {state === 'on' ? 'Re-connect this device' : 'Turn on notifications'}
          </Button>
        )}
      </div>
    </Card>
  );
}

