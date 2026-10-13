import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { generateSecret, generateURI, verify as totpVerify } from 'otplib';
import { config } from '../../config.js';
import { audit } from '../../core/audit.js';
import type { Actor, Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, conflict, notFound, unauthorized } from '../../core/errors.js';
import { Access, type Grant, isPermission, type Override } from '../../core/permissions.js';
import type { Tx } from '../../db/db.js';
import { withSystem } from '../../db/db.js';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => argonHash(pw, ARGON);
export const verifyPassword = (hash: string, pw: string) => argonVerify(hash, pw).catch(() => false);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Readable temporary password, e.g. "kbay-4821-mango". */
export function generateTempPassword(): string {
  const words = ['mango', 'chilli', 'masala', 'potato', 'crispy', 'golden', 'salt', 'pepper', 'garlic', 'tikka'];
  return `kbay-${randomInt(1000, 9999)}-${words[randomInt(0, words.length)]}-${randomInt(10, 99)}`;
}

export function validateNewPassword(pw: string): void {
  if (pw.length < 10) throw badRequest('weak_password', 'Use at least 10 characters.');
  if (/^kbay-\d{4}-/.test(pw)) throw badRequest('weak_password', 'Choose your own password, not the temporary one.');
}

export interface AuthInfo {
  sessionId: string;
  tenantId: string | null;
  actor: Actor;
  mustChangePassword: boolean;
  totpRequired: boolean;
  access: Access;
}

export async function login(username: string, password: string, meta: { ip?: string; userAgent?: string }) {
  return withSystem(async (tx) => {
    const [u] = await tx<{ id: string; tenant_id: string | null; password_hash: string; active: boolean;
      must_change_password: boolean; totp_enabled: boolean }[]>`
      select id, tenant_id, password_hash, active, must_change_password, totp_enabled
      from core.users where lower(username) = lower(${username.trim()})`;
    // Verify even when the user is missing so timing does not reveal valid usernames.
    const ok = await verifyPassword(u?.password_hash ?? '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$Zm9v', password);
    if (!u || !ok || !u.active) {
      await audit(tx, { tenantId: u?.tenant_id ?? null, actorUserId: u?.id, action: 'auth.login_failed', entityType: 'user',
        entityId: u?.id ?? null, after: { username }, ip: meta.ip });
      throw unauthorized('Wrong username or password.');
    }
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
    await tx`insert into core.sessions (user_id, tenant_id, token_hash, expires_at, ip, user_agent, totp_passed)
      values (${u.id}, ${u.tenant_id}, ${sha256(token)}, ${expires}, ${meta.ip ?? null}, ${meta.userAgent ?? null}, ${!u.totp_enabled})`;
    await tx`update core.users set last_login_at = now() where id = ${u.id}`;
    await audit(tx, { tenantId: u.tenant_id, actorUserId: u.id, action: 'auth.login', entityType: 'user', entityId: u.id, ip: meta.ip });
    return { token, expires, mustChangePassword: u.must_change_password, totpRequired: u.totp_enabled };
  });
}

export async function logout(token: string) {
  await withSystem((tx) => tx`update core.sessions set revoked_at = now() where token_hash = ${sha256(token)}`);
}

export async function loadAccess(tx: Tx, userId: string, isPlatformOwner: boolean): Promise<Access> {
  const grants = await tx<{ permissions: string[]; all_orgs: boolean; org_ids: string[]; location_ids: string[] }[]>`
    select r.permissions, a.all_orgs, a.org_ids, a.location_ids
    from core.role_assignments a join core.roles r on r.id = a.role_id
    where a.user_id = ${userId} and a.revoked_at is null`;
  const overrides = await tx<{ permission: string; org_id: string | null; effect: 'grant' | 'deny' }[]>`
    select permission, org_id, effect from core.user_permission_overrides where user_id = ${userId}`;
  const g: Grant[] = grants.map((r) => ({ permissions: r.permissions, allOrgs: r.all_orgs, orgIds: r.org_ids, locationIds: r.location_ids }));
  const o: Override[] = overrides.map((r) => ({ permission: r.permission, orgId: r.org_id, effect: r.effect }));
  return new Access(g, o, isPlatformOwner);
}

export async function authenticate(token: string): Promise<AuthInfo | null> {
  if (!token) return null;
  return withSystem(async (tx) => {
    const [s] = await tx<{ id: string; user_id: string; tenant_id: string | null; totp_passed: boolean; username: string;
      person_id: string | null; is_platform_owner: boolean; must_change_password: boolean; totp_enabled: boolean;
      display_name: string | null; full_name: string | null; last_seen_at: Date }[]>`
      select s.id, s.user_id, s.tenant_id, s.totp_passed, u.username, u.person_id, u.is_platform_owner,
             u.must_change_password, u.totp_enabled, p.display_name, p.full_name, s.last_seen_at
      from core.sessions s join core.users u on u.id = s.user_id left join core.people p on p.id = u.person_id
      where s.token_hash = ${sha256(token)} and s.revoked_at is null and s.expires_at > now() and u.active`;
    if (!s) return null;
    if (Date.now() - s.last_seen_at.getTime() > 60_000) {
      await tx`update core.sessions set last_seen_at = now() where id = ${s.id}`;
    }
    const access = await loadAccess(tx, s.user_id, s.is_platform_owner);
    return {
      sessionId: s.id,
      tenantId: s.tenant_id,
      mustChangePassword: s.must_change_password,
      totpRequired: s.totp_enabled && !s.totp_passed,
      access,
      actor: {
        userId: s.user_id,
        personId: s.person_id,
        username: s.username,
        displayName: s.display_name ?? s.full_name ?? s.username,
        isPlatformOwner: s.is_platform_owner,
      },
    };
  });
}

export async function changePassword(userId: string, current: string, next: string, ip?: string) {
  validateNewPassword(next);
  await withSystem(async (tx) => {
    const [u] = await tx<{ password_hash: string; tenant_id: string | null }[]>`
      select password_hash, tenant_id from core.users where id = ${userId}`;
    if (!u) throw notFound('User');
    if (!(await verifyPassword(u.password_hash, current))) throw badRequest('wrong_password', 'Current password is wrong.');
    if (current === next) throw badRequest('same_password', 'Choose a different password.');
    await tx`update core.users set password_hash = ${await hashPassword(next)}, must_change_password = false where id = ${userId}`;
    await audit(tx, { tenantId: u.tenant_id, actorUserId: userId, action: 'auth.password_changed', entityType: 'user', entityId: userId, ip });
  });
}

// ---- Two-factor (TOTP). Optional today; can be made mandatory for the owner later. ----

export async function totpBegin(userId: string, username: string) {
  const secret = generateSecret();
  await withSystem((tx) => tx`update core.users set totp_secret = ${secret} where id = ${userId} and not totp_enabled`);
  return { secret, uri: generateURI({ issuer: 'Opplox', label: username, secret }) };
}

export async function totpEnable(userId: string, code: string, sessionId: string) {
  await withSystem(async (tx) => {
    const [u] = await tx<{ totp_secret: string | null; totp_enabled: boolean; tenant_id: string | null }[]>`
      select totp_secret, totp_enabled, tenant_id from core.users where id = ${userId}`;
    if (!u?.totp_secret) throw badRequest('totp_not_started', 'Start two-factor setup first.');
    if (u.totp_enabled) throw conflict('totp_enabled', 'Two-factor is already on.');
    if (!(await totpCheck(u.totp_secret, code))) throw badRequest('bad_code', 'That code is not right.');
    await tx`update core.users set totp_enabled = true where id = ${userId}`;
    await tx`update core.sessions set totp_passed = true where id = ${sessionId}`;
    await audit(tx, { tenantId: u.tenant_id, actorUserId: userId, action: 'auth.totp_enabled', entityType: 'user', entityId: userId });
  });
}

export async function totpVerifySession(userId: string, sessionId: string, code: string) {
  await withSystem(async (tx) => {
    const [u] = await tx<{ totp_secret: string | null }[]>`select totp_secret from core.users where id = ${userId}`;
    if (!u?.totp_secret || !(await totpCheck(u.totp_secret, code))) throw badRequest('bad_code', 'That code is not right.');
    await tx`update core.sessions set totp_passed = true where id = ${sessionId}`;
  });
}

async function totpCheck(secret: string, code: string): Promise<boolean> {
  try {
    const r = await totpVerify({ secret, token: code.replace(/\s/g, ''), epochTolerance: 30 } as never);
    return Boolean((r as { valid?: boolean }).valid);
  } catch {
    return false;
  }
}

// ---- People, users and roles (tenant admin) ----

export async function listUsers(ctx: Ctx, orgId: string) {
  requirePerm(ctx, 'users.manage', orgId);
  return ctx.tx`
    select u.id, u.username, u.active, u.must_change_password, u.last_login_at, u.totp_enabled,
           p.id as person_id, p.full_name, p.display_name, p.phone,
           coalesce((select json_agg(json_build_object('assignmentId', a.id, 'roleId', r.id, 'roleKey', r.key, 'roleName', r.name,
              'allOrgs', a.all_orgs, 'orgIds', a.org_ids, 'locationIds', a.location_ids) order by r.name)
            from core.role_assignments a join core.roles r on r.id = a.role_id
            where a.user_id = u.id and a.revoked_at is null), '[]') as roles,
           coalesce((select json_agg(json_build_object('id', o.id, 'permission', o.permission, 'orgId', o.org_id, 'effect', o.effect))
            from core.user_permission_overrides o where o.user_id = u.id), '[]') as overrides
    from core.users u left join core.people p on p.id = u.person_id
    where u.tenant_id = ${ctx.tenantId}
    order by coalesce(p.display_name, p.full_name, u.username)`;
}

export async function createUser(ctx: Ctx, orgId: string, input: { personId: string; username: string }) {
  requirePerm(ctx, 'users.manage', orgId);
  const temp = generateTempPassword();
  const [u] = await ctx.tx<{ id: string }[]>`
    insert into core.users (tenant_id, person_id, username, password_hash, must_change_password)
    values (${ctx.tenantId}, ${input.personId}, ${input.username.trim().toLowerCase()}, ${await hashPassword(temp)}, true)
    returning id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'user.created', entityType: 'user',
    entityId: u!.id, after: { username: input.username, personId: input.personId } });
  return { id: u!.id, temporaryPassword: temp };
}

export async function resetPassword(ctx: Ctx, orgId: string, userId: string) {
  requirePerm(ctx, 'users.manage', orgId);
  const temp = generateTempPassword();
  const r = await ctx.tx`update core.users set password_hash = ${await hashPassword(temp)}, must_change_password = true
    where id = ${userId} and tenant_id = ${ctx.tenantId}`;
  if (r.count === 0) throw notFound('User');
  await ctx.tx`update core.sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'user.password_reset', entityType: 'user', entityId: userId });
  return { temporaryPassword: temp };
}

export async function setUserActive(ctx: Ctx, orgId: string, userId: string, active: boolean) {
  requirePerm(ctx, 'users.manage', orgId);
  if (userId === ctx.actor.userId && !active) throw badRequest('self_disable', 'You cannot disable yourself.');
  await ctx.tx`update core.users set active = ${active} where id = ${userId} and tenant_id = ${ctx.tenantId}`;
  if (!active) await ctx.tx`update core.sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: active ? 'user.enabled' : 'user.disabled', entityType: 'user', entityId: userId });
}

export async function listRoles(ctx: Ctx) {
  return ctx.tx`select id, key, name, description, permissions, is_system from core.roles order by name`;
}

export async function upsertRole(ctx: Ctx, orgId: string, input: { id?: string; key: string; name: string; description?: string; permissions: string[] }) {
  requirePerm(ctx, 'roles.manage', orgId);
  const bad = input.permissions.filter((p) => !isPermission(p));
  if (bad.length) throw badRequest('unknown_permission', `Unknown permissions: ${bad.join(', ')}`);
  if (input.permissions.includes('*') && !ctx.access.can('roles.manage', orgId)) throw badRequest('forbidden', 'Not allowed');
  if (input.id) {
    const [before] = await ctx.tx`select name, permissions from core.roles where id = ${input.id}`;
    if (!before) throw notFound('Role');
    await ctx.tx`update core.roles set name = ${input.name}, description = ${input.description ?? null}, permissions = ${input.permissions}
      where id = ${input.id}`;
    await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'role.updated', entityType: 'role',
      entityId: input.id, before, after: { name: input.name, permissions: input.permissions } });
    return { id: input.id };
  }
  const [r] = await ctx.tx<{ id: string }[]>`insert into core.roles (tenant_id, key, name, description, permissions)
    values (${ctx.tenantId}, ${input.key}, ${input.name}, ${input.description ?? null}, ${input.permissions}) returning id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'role.created', entityType: 'role',
    entityId: r!.id, after: input });
  return { id: r!.id };
}

export async function assignRole(ctx: Ctx, orgId: string, input: { userId: string; roleId: string; allOrgs: boolean; orgIds: string[]; locationIds: string[] }) {
  requirePerm(ctx, 'roles.manage', orgId);
  if (!input.allOrgs && input.orgIds.length === 0) throw badRequest('scope_required', 'Pick all organizations or at least one.');
  // Granting cross-org scope needs the granter to hold role management in every org they tick.
  for (const o of input.orgIds) requirePerm(ctx, 'roles.manage', o);
  const [a] = await ctx.tx<{ id: string }[]>`
    insert into core.role_assignments (tenant_id, user_id, role_id, all_orgs, org_ids, location_ids, granted_by)
    values (${ctx.tenantId}, ${input.userId}, ${input.roleId}, ${input.allOrgs}, ${input.orgIds}, ${input.locationIds}, ${ctx.actor.userId})
    returning id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'role.assigned', entityType: 'role_assignment',
    entityId: a!.id, after: input });
  return { id: a!.id };
}

export async function revokeRole(ctx: Ctx, orgId: string, assignmentId: string) {
  requirePerm(ctx, 'roles.manage', orgId);
  await ctx.tx`update core.role_assignments set revoked_at = now() where id = ${assignmentId} and revoked_at is null`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'role.revoked', entityType: 'role_assignment', entityId: assignmentId });
}

export async function setOverride(ctx: Ctx, orgId: string, input: { userId: string; permission: string; effect: 'grant' | 'deny' | 'clear'; scopeOrgId: string | null }) {
  requirePerm(ctx, 'roles.manage', orgId);
  if (input.permission === '*' || !isPermission(input.permission)) throw badRequest('unknown_permission', 'Unknown permission');
  await ctx.tx`delete from core.user_permission_overrides where user_id = ${input.userId} and permission = ${input.permission}
    and org_id is not distinct from ${input.scopeOrgId}`;
  if (input.effect !== 'clear') {
    await ctx.tx`insert into core.user_permission_overrides (tenant_id, user_id, permission, org_id, effect, created_by)
      values (${ctx.tenantId}, ${input.userId}, ${input.permission}, ${input.scopeOrgId}, ${input.effect}, ${ctx.actor.userId})`;
  }
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'permission.override', entityType: 'user',
    entityId: input.userId, after: input });
}

/** Users who can act on a permission within an org/location (approval routing, notifications). */
export async function usersWithPermission(tx: Tx, orgId: string, permission: string, locationId?: string | null): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    select distinct u.id from core.users u
    where u.active and (
      exists (select 1 from core.role_assignments a join core.roles r on r.id = a.role_id
              where a.user_id = u.id and a.revoked_at is null
                and (${permission} = any(r.permissions) or '*' = any(r.permissions))
                and (a.all_orgs or ${orgId}::uuid = any(a.org_ids))
                and (${locationId ?? null}::uuid is null or cardinality(a.location_ids) = 0 or ${locationId ?? null}::uuid = any(a.location_ids)))
      or exists (select 1 from core.user_permission_overrides o where o.user_id = u.id and o.permission = ${permission}
                 and o.effect = 'grant' and (o.org_id is null or o.org_id = ${orgId}))
    )
    and not exists (select 1 from core.user_permission_overrides o where o.user_id = u.id and o.permission = ${permission}
                    and o.effect = 'deny' and (o.org_id is null or o.org_id = ${orgId}))`;
  return rows.map((r) => r.id);
}
