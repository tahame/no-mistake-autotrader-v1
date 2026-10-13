import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { post } from '../api';
import { Button, ErrorText, Field, Input } from '../components/ui';
import { InstallSteps } from './Install';

function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/icons/icon.svg" alt="" className="h-16 w-16" />
          <div className="text-2xl font-black tracking-tight">K-BAY</div>
        </div>
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
          <h1 className="text-lg font-semibold">{title}</h1>
          {sub ? <p className="mt-1 text-sm text-[var(--muted)]">{sub}</p> : null}
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Login() {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/login', { username, password });
      await qc.invalidateQueries();
      window.location.href = '/';
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Sign in">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Username"><Input autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <ErrorText error={error} />
        <Button variant="primary" size="lg" className="w-full" busy={busy}>Sign in</Button>
      </form>
    </Shell>
  );
}

export function ChangePassword({ first }: { first?: boolean }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setError(new Error('The two new passwords do not match.'));
    setBusy(true);
    setError(null);
    try {
      await post('/auth/password', { current, next });
      setDone(true);
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (done && first) {
    return (
      <Shell title="You're all set" sub="Install K-BAY on your phone so it opens like an app.">
        <InstallSteps />
        <Button variant="primary" size="lg" className="mt-4 w-full" onClick={() => (window.location.href = '/')}>Continue</Button>
      </Shell>
    );
  }
  const form = (
    <form onSubmit={submit} className="space-y-3">
      <Field label={first ? 'Temporary password' : 'Current password'}>
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" hint="At least 10 characters.">
        <Input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
      </Field>
      <Field label="New password again">
        <Input type="password" autoComplete="new-password" minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} required />
      </Field>
      <ErrorText error={error} />
      {done ? <p className="text-sm text-[var(--good)]">Password changed.</p> : null}
      <Button variant="primary" size="lg" className="w-full" busy={busy}>Save password</Button>
    </form>
  );
  return first ? <Shell title="Set your own password" sub="Welcome! Replace the temporary password you were given.">{form}</Shell> : form;
}

export function TotpPrompt() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/auth/totp/verify', { code });
      window.location.href = '/';
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Two-factor code" sub="Enter the 6-digit code from your authenticator app.">
      <form onSubmit={submit} className="space-y-3">
        <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={8} required />
        <ErrorText error={error} />
        <Button variant="primary" size="lg" className="w-full" busy={busy}>Verify</Button>
      </form>
    </Shell>
  );
}
