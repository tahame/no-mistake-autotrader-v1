import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError } from '../api';
import { fromMinorInput, rs, toMinor } from '../format';

// Shared building blocks. Everything is sized for fingers first (tablets replace POS hardware),
// then scales up for desktop.

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'good';
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-brand-ink hover:brightness-95 font-semibold',
  secondary: 'bg-[var(--panel-2)] text-[var(--ink)] border border-[var(--line)] hover:brightness-95',
  danger: 'bg-accent text-white hover:brightness-110 font-semibold',
  good: 'bg-green-700 text-white hover:brightness-110 font-semibold',
  ghost: 'text-[var(--ink)] hover:bg-[var(--panel-2)]',
};

export function Button({ variant = 'secondary', size = 'md', className, busy, children, ...p }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; busy?: boolean }) {
  const sizes = { sm: 'h-9 px-3 text-sm', md: 'h-11 px-4', lg: 'h-14 px-6 text-lg' };
  return (
    <button {...p} disabled={p.disabled || busy}
      className={cx('inline-flex items-center justify-center gap-2 rounded-xl transition disabled:opacity-50 disabled:pointer-events-none select-none',
        variants[variant], sizes[size], className)}>
      {busy ? <Spinner /> : null}{children}
    </button>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-label="Loading" />;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 sm:p-5', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="text-base font-semibold">{title}</h2> : <span />}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {sub ? <p className="mt-1 text-sm text-[var(--muted)]">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-[var(--muted)]">{hint}</span> : null}
    </label>
  );
}

const inputCls = 'h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 outline-none focus:border-brand focus:ring-2 focus:ring-brand/30';

export function Input(p: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx(inputCls, p.className)} />;
}

export function Select({ options, placeholder, ...p }: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select {...p} className={cx(inputCls, p.className)}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Textarea(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx(inputCls, 'h-auto min-h-20 py-2', p.className)} />;
}

/** Rupee input that reports paisa (or null while invalid/empty). */
export function MoneyInput({ value, onChange, ...p }: { value: number | null; onChange: (minor: number | null) => void } &
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value === null ? '' : fromMinorInput(value));
  useEffect(() => {
    if (value === null && text !== '' && toMinor(text) !== null) setText('');
    else if (value !== null && toMinor(text) !== value) setText(fromMinorInput(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted)]">Rs</span>
      <input {...p} inputMode="decimal" value={text} className={cx(inputCls, 'pl-9 tabular')}
        onChange={(e) => { setText(e.target.value); onChange(e.target.value.trim() === '' ? null : toMinor(e.target.value)); }} />
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'brand'; children: ReactNode }) {
  const t = {
    neutral: 'bg-[var(--panel-2)] text-[var(--muted)]',
    good: 'bg-green-600/15 text-[var(--good)]',
    bad: 'bg-red-600/15 text-[var(--bad)]',
    warn: 'bg-amber-500/15 text-[var(--warn)]',
    brand: 'bg-brand/20 text-[var(--ink)]',
  }[tone];
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', t)}>{children}</span>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className={cx('mt-1 text-2xl font-bold tabular', tone === 'good' && 'text-[var(--good)]', tone === 'bad' && 'text-[var(--bad)]')}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-[var(--muted)]">{sub}</div> : null}
    </div>
  );
}

export function Money({ minor, className, sign }: { minor: number | null | undefined; className?: string; sign?: boolean }) {
  return <span className={cx('tabular', className, (minor ?? 0) < 0 && 'text-[var(--bad)]')}>{rs(minor, { sign })}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-[var(--line)] p-6 text-center text-sm text-[var(--muted)]">{children}</div>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  return <p role="alert" className="rounded-xl bg-red-600/10 px-3 py-2 text-sm text-[var(--bad)]">{msg}</p>;
}

export function Loading() {
  return <div className="flex items-center gap-2 p-6 text-[var(--muted)]"><Spinner /> Loading…</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-[var(--panel-2)] p-1">
      {tabs.map((t) => (
        <button key={t.value} onClick={() => onChange(t.value)}
          className={cx('h-10 shrink-0 rounded-lg px-4 text-sm font-medium', value === t.value ? 'bg-[var(--panel)] shadow-sm' : 'text-[var(--muted)]')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A modal that becomes a bottom sheet on phones. */
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode;
  footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={cx('flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-[var(--panel)] sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="h-10 w-10 rounded-lg text-2xl leading-none hover:bg-[var(--panel-2)]" aria-label="Close">×</button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--line)] px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Responsive table: rows become cards on narrow screens. */
export function Table<T>({ rows, columns, empty, rowKey, onRowClick }: {
  rows: T[]; rowKey: (r: T) => string; empty?: ReactNode; onRowClick?: (r: T) => void;
  columns: { label: string; render: (r: T) => ReactNode; align?: 'right'; className?: string; hideOnMobile?: boolean }[];
}) {
  if (rows.length === 0) return <Empty>{empty ?? 'Nothing here yet.'}</Empty>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
              {columns.map((c) => <th key={c.label} className={cx('px-2 py-2 font-medium', c.align === 'right' && 'text-right')}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cx('border-b border-[var(--line)] last:border-0', onRowClick && 'cursor-pointer hover:bg-[var(--panel-2)]')}>
                {columns.map((c) => <td key={c.label} className={cx('px-2 py-2.5 align-top', c.align === 'right' && 'text-right tabular', c.className)}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 md:hidden">
        {rows.map((r) => (
          <div key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
            className={cx('rounded-xl border border-[var(--line)] p-3', onRowClick && 'active:bg-[var(--panel-2)]')}>
            {columns.filter((c) => !c.hideOnMobile).map((c, i) => (
              <div key={c.label} className={cx('flex justify-between gap-3 text-sm', i > 0 && 'mt-1')}>
                <span className="text-[var(--muted)]">{c.label}</span>
                <span className={cx('text-right', c.align === 'right' && 'tabular')}>{c.render(r)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

// ---- Toasts ----
interface Toast { id: number; text: string; tone: 'good' | 'bad' }
const ToastCtx = createContext<(text: string, tone?: 'good' | 'bad') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'good' | 'bad' = 'good') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={cx('rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg', t.tone === 'good' ? 'bg-green-700' : 'bg-red-700')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export { cx };
