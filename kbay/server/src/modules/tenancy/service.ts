import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import type { Tx } from '../../db/db.js';

// Hooks let other modules set up their own data when an org or location is created
// (chart of accounts, cash drawer account) without tenancy depending on them.
type OrgHook = (tx: Tx, tenantId: string, orgId: string) => Promise<void>;
type LocationHook = (tx: Tx, tenantId: string, orgId: string, locationId: string, name: string, actorUserId: string | null) => Promise<void>;
const orgHooks: OrgHook[] = [];
const locationHooks: LocationHook[] = [];
export const onOrgCreated = (h: OrgHook) => orgHooks.push(h);
export const onLocationCreated = (h: LocationHook) => locationHooks.push(h);

export interface OrgRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  brand_name: string;
  currency: string;
  currency_minor_units: number;
  timezone: string;
  settings: Record<string, unknown>;
}

/** Calendar date (YYYY-MM-DD) in the org's timezone. */
export function localDate(timezone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Hour and minute "HH:MM" in the org's timezone. */
export function localTime(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

export async function getOrg(tx: Tx, orgId: string): Promise<OrgRow> {
  const [o] = await tx<OrgRow[]>`select id, tenant_id, slug, name, brand_name, currency, currency_minor_units, timezone, settings
    from core.organizations where id = ${orgId}`;
  if (!o) throw notFound('Organization');
  return o;
}

export async function getLocation(tx: Tx, locationId: string) {
  const [l] = await tx<{ id: string; org_id: string; name: string; kind: string; approval_limit_minor: number; active: boolean }[]>`
    select id, org_id, name, kind, approval_limit_minor, active from core.locations where id = ${locationId}`;
  if (!l) throw notFound('Location');
  return l;
}

/** Ensure a location belongs to an org (guards against mixing ids across orgs). */
export async function assertLocationInOrg(tx: Tx, orgId: string, locationId: string) {
  const l = await getLocation(tx, locationId);
  if (l.org_id !== orgId) throw badRequest('wrong_org', 'That location belongs to another organization.');
  return l;
}

export async function myWorkspace(ctx: Ctx) {
  const [tenant] = await ctx.tx<{ id: string; name: string; slug: string; otp_enabled: boolean }[]>`
    select id, name, slug, otp_enabled from core.tenants where id = ${ctx.tenantId}`;
  const orgs = await ctx.tx<OrgRow[]>`select id, tenant_id, slug, name, brand_name, currency, currency_minor_units, timezone, settings
    from core.organizations where active order by name`;
  const visible = ctx.access.orgIds(orgs.map((o) => o.id));
  const out = [];
  for (const o of orgs.filter((x) => visible.includes(x.id))) {
    const scope = ctx.access.locationScope(o.id);
    const locations = await ctx.tx`select id, name, kind, city, approval_limit_minor, active from core.locations
      where org_id = ${o.id} and active and (${scope === null} or id = any(${scope ?? []}::uuid[])) order by name`;
    out.push({ ...o, locations, permissions: ctx.access.effective(o.id) });
  }
  return { tenant, orgs: out };
}

export async function listLocations(ctx: Ctx, orgId: string) {
  return ctx.tx`select id, name, kind, city, address, approval_limit_minor, active, created_at from core.locations
    where org_id = ${orgId} order by name`;
}

export async function createLocation(ctx: Ctx, orgId: string, input: { name: string; kind: 'stall' | 'shop'; city?: string; address?: string; approvalLimitMinor: number }) {
  requirePerm(ctx, 'settings.manage', orgId);
  const [l] = await ctx.tx<{ id: string }[]>`
    insert into core.locations (tenant_id, org_id, name, kind, city, address, approval_limit_minor)
    values (${ctx.tenantId}, ${orgId}, ${input.name.trim()}, ${input.kind}, ${input.city ?? null}, ${input.address ?? null}, ${input.approvalLimitMinor})
    returning id`;
  for (const h of locationHooks) await h(ctx.tx, ctx.tenantId, orgId, l!.id, input.name.trim(), ctx.actor.userId);
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'location.created', entityType: 'location', entityId: l!.id, after: input });
  return { id: l!.id };
}

export async function updateLocation(ctx: Ctx, orgId: string, locationId: string, input: { name?: string; kind?: 'stall' | 'shop';
  city?: string | null; address?: string | null; approvalLimitMinor?: number; active?: boolean }) {
  requirePerm(ctx, 'settings.manage', orgId);
  await assertLocationInOrg(ctx.tx, orgId, locationId);
  const [before] = await ctx.tx<{ city: string | null; address: string | null }[]>`
    select name, kind, city, address, approval_limit_minor, active from core.locations where id = ${locationId}`;
  await ctx.tx`update core.locations set
      name = coalesce(${input.name ?? null}, name), kind = coalesce(${input.kind ?? null}, kind),
      city = ${input.city === undefined ? before!.city : input.city},
      address = ${input.address === undefined ? before!.address : input.address},
      approval_limit_minor = coalesce(${input.approvalLimitMinor ?? null}, approval_limit_minor),
      active = coalesce(${input.active ?? null}, active)
    where id = ${locationId}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'location.updated', entityType: 'location', entityId: locationId, before, after: input });
}

export async function updateOrg(ctx: Ctx, orgId: string, input: { name?: string; brandName?: string; currency?: string; timezone?: string; settings?: Record<string, unknown> }) {
  requirePerm(ctx, 'settings.manage', orgId);
  const before = await getOrg(ctx.tx, orgId);
  if (input.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { throw badRequest('bad_timezone', 'Unknown timezone'); }
  }
  await ctx.tx`update core.organizations set name = coalesce(${input.name ?? null}, name), brand_name = coalesce(${input.brandName ?? null}, brand_name),
    currency = coalesce(${input.currency ?? null}, currency), timezone = coalesce(${input.timezone ?? null}, timezone),
    settings = settings || ${ctx.tx.json((input.settings ?? {}) as never)}
    where id = ${orgId}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'org.updated', entityType: 'organization', entityId: orgId, before, after: input });
}

/** Creating an organization is a tenant-wide action (super admin). */
export async function createOrg(ctx: Ctx, input: { name: string; slug: string; brandName: string; currency?: string; timezone?: string }) {
  if (!ctx.access.grants.some((g) => g.allOrgs && (g.permissions.includes('*') || g.permissions.includes('settings.manage')))) {
    throw forbidden('Only a tenant-wide administrator can add organizations.');
  }
  const id = await createOrgRaw(ctx.tx, ctx.tenantId, input);
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId: id, actorUserId: ctx.actor.userId, action: 'org.created', entityType: 'organization', entityId: id, after: input });
  return { id };
}

export async function createOrgRaw(tx: Tx, tenantId: string, input: { name: string; slug: string; brandName: string; currency?: string; timezone?: string }) {
  const [o] = await tx<{ id: string }[]>`
    insert into core.organizations (tenant_id, slug, name, brand_name, currency, timezone)
    values (${tenantId}, ${input.slug}, ${input.name}, ${input.brandName}, ${input.currency ?? 'PKR'}, ${input.timezone ?? 'Asia/Karachi'})
    returning id`;
  for (const h of orgHooks) await h(tx, tenantId, o!.id);
  return o!.id;
}

export async function createLocationRaw(tx: Tx, tenantId: string, orgId: string, input: { name: string; kind: 'stall' | 'shop'; city?: string; approvalLimitMinor: number }) {
  const [l] = await tx<{ id: string }[]>`
    insert into core.locations (tenant_id, org_id, name, kind, city, approval_limit_minor)
    values (${tenantId}, ${orgId}, ${input.name}, ${input.kind}, ${input.city ?? null}, ${input.approvalLimitMinor}) returning id`;
  for (const h of locationHooks) await h(tx, tenantId, orgId, l!.id, input.name, null);
  return l!.id;
}

// ---- People (everyone on file: employees, partners, investors) ----

export async function listPeople(ctx: Ctx, orgId: string) {
  return ctx.tx`
    select p.id, p.full_name, p.display_name, p.phone, p.email, p.cnic, p.address, p.notes, p.created_at,
           (select u.id from core.users u where u.person_id = p.id limit 1) as user_id,
           (select u.username from core.users u where u.person_id = p.id limit 1) as username
    from core.people p join core.person_orgs po on po.person_id = p.id and po.org_id = ${orgId}
    order by coalesce(p.display_name, p.full_name)`;
}

export async function createPerson(ctx: Ctx, orgId: string, input: { fullName: string; displayName?: string; phone?: string; email?: string;
  cnic?: string; address?: string; notes?: string }) {
  requirePerm(ctx, 'users.manage', orgId);
  const [p] = await ctx.tx<{ id: string }[]>`
    insert into core.people (tenant_id, full_name, display_name, phone, email, cnic, address, notes)
    values (${ctx.tenantId}, ${input.fullName}, ${input.displayName ?? null}, ${input.phone ?? null}, ${input.email ?? null},
      ${input.cnic ?? null}, ${input.address ?? null}, ${input.notes ?? null}) returning id`;
  await ctx.tx`insert into core.person_orgs (tenant_id, person_id, org_id) values (${ctx.tenantId}, ${p!.id}, ${orgId})`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'person.created', entityType: 'person', entityId: p!.id, after: input });
  return { id: p!.id };
}

export async function updatePerson(ctx: Ctx, orgId: string, personId: string, input: Record<string, string | null | undefined>) {
  requirePerm(ctx, 'users.manage', orgId);
  const [before] = await ctx.tx`select * from core.people where id = ${personId}`;
  if (!before) throw notFound('Person');
  await ctx.tx`update core.people set
    full_name = coalesce(${input.fullName ?? null}, full_name), display_name = ${input.displayName ?? before.display_name},
    phone = ${input.phone ?? before.phone}, email = ${input.email ?? before.email}, cnic = ${input.cnic ?? before.cnic},
    address = ${input.address ?? before.address}, notes = ${input.notes ?? before.notes}
    where id = ${personId}`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'person.updated', entityType: 'person', entityId: personId, before, after: input });
}

/** Add an existing tenant person (e.g. an investor) to another organization of the same customer. */
export async function linkPersonToOrg(ctx: Ctx, orgId: string, personId: string) {
  requirePerm(ctx, 'users.manage', orgId);
  await ctx.tx`insert into core.person_orgs (tenant_id, person_id, org_id) values (${ctx.tenantId}, ${personId}, ${orgId}) on conflict do nothing`;
}

export async function personUserId(tx: Tx, personId: string): Promise<string | null> {
  const [u] = await tx<{ id: string }[]>`select id from core.users where person_id = ${personId} and active limit 1`;
  return u?.id ?? null;
}

export async function moduleEnabled(tx: Tx, tenantId: string, module: string): Promise<boolean> {
  const [r] = await tx<{ enabled: boolean }[]>`select enabled from core.tenant_modules where tenant_id = ${tenantId} and module = ${module}`;
  return r?.enabled ?? true;
}
