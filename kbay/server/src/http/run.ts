import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Ctx } from '../core/context.js';
import { AppError, forbidden, unauthorized } from '../core/errors.js';
import { withTenant } from '../db/db.js';
import { type AuthInfo, authenticate } from '../modules/identity/index.js';
import { moduleEnabled } from '../modules/tenancy/index.js';

export const SESSION_COOKIE = 'kbay_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

export function sessionToken(req: FastifyRequest): string | null {
  const c = req.cookies?.[SESSION_COOKIE];
  if (c) return c;
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return null;
}

export async function authHook(req: FastifyRequest) {
  const token = sessionToken(req);
  req.auth = token ? await authenticate(token) : null;
}

export function setSessionCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', path: '/', expires });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** The signed-in user, after the password-change and two-factor gates. */
export function requireAuth(req: FastifyRequest, opts: { allowPasswordChange?: boolean } = {}): AuthInfo {
  const auth = req.auth;
  if (!auth) throw unauthorized();
  if (auth.totpRequired) throw new AppError(401, 'totp_required', 'Enter your two-factor code.');
  if (auth.mustChangePassword && !opts.allowPasswordChange) {
    throw new AppError(403, 'password_change_required', 'Set your own password first.');
  }
  return auth;
}

/**
 * Run a request as one tenant-scoped transaction. Everything a request writes commits together
 * or not at all; work registered with afterCommit (e.g. event delivery) runs after the commit.
 */
export async function run<T>(req: FastifyRequest, fn: (ctx: Ctx) => Promise<T>, opts: { module?: string; allowPasswordChange?: boolean } = {}): Promise<T> {
  const auth = requireAuth(req, opts);
  const tenantId = auth.tenantId;
  if (!tenantId) throw forbidden('This account has no workspace.');
  const after: (() => void | Promise<void>)[] = [];
  const result = await withTenant(tenantId, async (tx) => {
    if (opts.module && !(await moduleEnabled(tx, tenantId, opts.module))) {
      throw forbidden(`The ${opts.module} module is not part of this plan.`);
    }
    return fn({ tx, tenantId, actor: auth.actor, access: auth.access, ip: req.ip, afterCommit: (f) => after.push(f) });
  });
  for (const f of after) {
    Promise.resolve()
      .then(f)
      .catch((err) => req.log.error(err, 'after-commit task failed'));
  }
  return result;
}
