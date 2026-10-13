import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, get } from './api';

export interface Location { id: string; name: string; kind: 'stall' | 'shop'; city: string | null; approval_limit_minor: number }
export interface Org {
  id: string; name: string; brand_name: string; currency: string; timezone: string; settings: Record<string, unknown>;
  locations: Location[]; permissions: string[];
}
export interface Me {
  user: { userId: string; personId: string | null; username: string; displayName: string; isPlatformOwner: boolean };
  tenantId: string | null; mustChangePassword: boolean; totpEnabled?: boolean; totpRequired: boolean;
}

interface Session {
  me: Me | null;
  loading: boolean;
  orgs: Org[];
  org: Org | null;
  location: Location | null;
  setOrgId: (id: string) => void;
  setLocationId: (id: string) => void;
  can: (perm: string) => boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

// Per-device conveniences only; the page works without them (private windows, blocked storage).
function remember(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQ = useQuery({
    queryKey: ['me'],
    queryFn: () => get<Me>('/auth/me').catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
    staleTime: 60_000,
  });
  const me = meQ.data ?? null;
  const ready = Boolean(me && !me.totpRequired && me.tenantId);
  const wsQ = useQuery({
    queryKey: ['workspace'],
    queryFn: () => get<{ tenant: { name: string }; orgs: Org[] }>('/workspace'),
    enabled: ready,
    staleTime: 60_000,
  });
  const orgs = wsQ.data?.orgs ?? [];
  const [orgId, setOrgIdState] = useState<string | null>(() => remember('kbay.org'));
  const [locationId, setLocationIdState] = useState<string | null>(() => remember('kbay.location'));

  const org = orgs.find((o) => o.id === orgId) ?? orgs[0] ?? null;
  const location = org?.locations.find((l) => l.id === locationId) ?? org?.locations[0] ?? null;

  useEffect(() => {
    if (org && org.id !== orgId) setOrgIdState(org.id);
    if (location && location.id !== locationId) setLocationIdState(location.id);
  }, [org, location, orgId, locationId]);

  const value = useMemo<Session>(() => ({
    me,
    loading: meQ.isLoading || (ready && wsQ.isLoading),
    orgs,
    org,
    location,
    setOrgId: (id) => { remember('kbay.org', id); setOrgIdState(id); },
    setLocationId: (id) => { remember('kbay.location', id); setLocationIdState(id); },
    can: (perm) => Boolean(org?.permissions.includes(perm)),
    refresh: async () => { await qc.invalidateQueries(); },
  }), [me, meQ.isLoading, ready, wsQ.isLoading, orgs, org, location, qc]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** The current org/location ids, for pages that need both (they render only once both exist). */
export function useScope() {
  const s = useSession();
  return { orgId: s.org?.id ?? '', locationId: s.location?.id ?? '', org: s.org!, location: s.location, can: s.can, me: s.me! };
}
