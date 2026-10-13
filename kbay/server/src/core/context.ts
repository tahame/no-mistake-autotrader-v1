import type { Tx } from '../db/db.js';
import { forbidden } from './errors.js';
import type { Access, Permission } from './permissions.js';

export interface Actor {
  userId: string;
  personId: string | null;
  username: string;
  displayName: string;
  isPlatformOwner: boolean;
}

/**
 * Everything a service call needs: the tenant-scoped transaction, who is acting and what they
 * may do. Work queued with afterCommit runs only once the transaction has committed.
 */
export interface Ctx {
  tx: Tx;
  tenantId: string;
  actor: Actor;
  access: Access;
  ip?: string;
  afterCommit: (fn: () => void | Promise<void>) => void;
}

export function requirePerm(ctx: Ctx, permission: Permission, orgId: string, locationId?: string | null): void {
  if (!ctx.access.can(permission, orgId, locationId)) {
    throw forbidden(`Missing permission: ${permission}`);
  }
}

/** System context for background jobs (scheduler, outbox consumers). */
export function systemActor(): Actor {
  return { userId: '00000000-0000-0000-0000-000000000000', personId: null, username: 'system', displayName: 'System', isPlatformOwner: false };
}
