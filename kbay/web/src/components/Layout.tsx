import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { get, post } from '../api';
import { useSession } from '../session';
import { cx } from './ui';

interface NavItem { to: string; label: string; icon: string; show: (can: (p: string) => boolean, owner: boolean) => boolean; primary?: boolean }

// Shown only when the person holds a permission that makes the page useful.
export const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: '◉', show: () => true, primary: true },
  { to: '/pos', label: 'Sell', icon: '▦', show: (c) => c('pos.sell'), primary: true },
  { to: '/day', label: 'Day', icon: '☀', show: (c) => c('day.open') || c('day.close') || c('reports.view'), primary: true },
  { to: '/approvals', label: 'Approvals', icon: '✓', show: (c) => c('comment.create'), primary: true },
  { to: '/spend', label: 'Spend', icon: '₨', show: (c) => c('expense.create') || c('purchase.create') || c('finance.view') },
  { to: '/inventory', label: 'Stock', icon: '▤', show: (c) => c('inventory.view') || c('inventory.request') },
  { to: '/money', label: 'Money', icon: '◫', show: (c) => c('finance.view') || c('reports.partners') || c('payroll.manage') },
  { to: '/reports', label: 'Reports', icon: '▲', show: (c) => c('reports.view') },
  { to: '/investor', label: 'Investor', icon: '◆', show: (c) => c('investor.portal') },
  { to: '/admin', label: 'Admin', icon: '⚙', show: (c) => c('users.manage') || c('roles.manage') || c('settings.manage') || c('menu.manage') || c('audit.view') },
  { to: '/owner', label: 'Owner', icon: '★', show: (_c, owner) => owner },
  { to: '/settings', label: 'My account', icon: '☺', show: () => true },
];

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <img src="/icons/icon.svg" alt="" className="h-8 w-8" />
      <span className="text-lg font-black tracking-tight">K-BAY</span>
    </div>
  );
}

export function Layout() {
  const s = useSession();
  const nav = useNavigate();
  const [more, setMore] = useState(false);
  const owner = Boolean(s.me?.user.isPlatformOwner);
  const items = NAV.filter((n) => n.show(s.can, owner));
  const primary = items.filter((n) => n.primary).slice(0, 4);
  const unread = useQuery({ queryKey: ['notifications', 'count'], queryFn: () => get<{ unread: number }>('/notifications?unread=true'),
    refetchInterval: 30_000 });

  const logout = async () => {
    await post('/auth/logout');
    window.location.href = '/login';
  };

  return (
    <div className="min-h-full lg:flex">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--panel)] p-4 lg:flex">
        <Logo />
        <nav className="mt-6 flex flex-1 flex-col gap-1">
          {items.map((n) => <SideLink key={n.to} to={n.to} icon={n.icon}>{n.label}</SideLink>)}
        </nav>
        <button onClick={logout} className="mt-4 h-10 rounded-lg text-left text-sm text-[var(--muted)] hover:bg-[var(--panel-2)] px-3">Sign out</button>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-[var(--line)] bg-[var(--panel)]/95 px-4 py-2 backdrop-blur pt-[max(0.5rem,env(safe-area-inset-top))]">
          <div className="lg:hidden"><Logo /></div>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {s.orgs.length > 1 && (
              <select aria-label="Business" value={s.org?.id ?? ''} onChange={(e) => s.setOrgId(e.target.value)}
                className="h-10 max-w-36 truncate rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2 text-sm">
                {s.orgs.map((o) => <option key={o.id} value={o.id}>{o.brand_name}</option>)}
              </select>
            )}
            {s.org && s.org.locations.length > 0 && (
              <select aria-label="Location" value={s.location?.id ?? ''} onChange={(e) => s.setLocationId(e.target.value)}
                className="h-10 max-w-44 truncate rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2 text-sm">
                {s.org.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
            <button onClick={() => nav('/notifications')} aria-label="Notifications"
              className="relative h-10 w-10 rounded-lg text-xl hover:bg-[var(--panel-2)]">
              🔔
              {(unread.data?.unread ?? 0) > 0 && (
                <span className="absolute right-1 top-1 min-w-5 rounded-full bg-accent px-1 text-[11px] font-bold leading-5 text-white">
                  {unread.data!.unread > 99 ? '99+' : unread.data!.unread}
                </span>
              )}
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-4 pb-28 lg:px-8 lg:py-6 lg:pb-8">
          <Outlet />
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[var(--line)] bg-[var(--panel)] pb-[env(safe-area-inset-bottom)] lg:hidden">
        {primary.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) =>
            cx('flex h-16 flex-col items-center justify-center gap-0.5 text-xs', isActive ? 'font-semibold text-[var(--ink)]' : 'text-[var(--muted)]')}>
            <span className="text-lg leading-none">{n.icon}</span>{n.label}
          </NavLink>
        ))}
        <button onClick={() => setMore(true)} className="flex h-16 flex-col items-center justify-center gap-0.5 text-xs text-[var(--muted)]">
          <span className="text-lg leading-none">☰</span>More
        </button>
      </nav>

      {more && (
        <div className="fixed inset-0 z-50 bg-black/50 lg:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-[var(--panel)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <div className="grid grid-cols-3 gap-2">
              {items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setMore(false)}
                  className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl bg-[var(--panel-2)] text-sm">
                  <span className="text-xl">{n.icon}</span>{n.label}
                </NavLink>
              ))}
            </div>
            <button onClick={logout} className="mt-3 h-12 w-full rounded-xl border border-[var(--line)] text-sm">Sign out</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SideLink({ to, icon, children }: { to: string; icon: string; children: ReactNode }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) =>
      cx('flex h-10 items-center gap-3 rounded-lg px-3 text-sm', isActive ? 'bg-brand/20 font-semibold' : 'text-[var(--muted)] hover:bg-[var(--panel-2)]')}>
      <span className="w-5 text-center">{icon}</span>{children}
    </NavLink>
  );
}
