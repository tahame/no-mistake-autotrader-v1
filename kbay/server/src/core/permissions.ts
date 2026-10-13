// The permission catalogue. Roles are configurable sets of these keys; a person can also be
// granted or denied a single key directly. '*' means every permission (super admin).

export const PERMISSIONS = {
  'pos.sell': 'Ring up sales on the POS',
  'pos.void': 'Void a sale (reason required)',
  'pos.refund': 'Request a refund (reason required)',
  'day.open': 'Open the business day and enter the cash float',
  'day.close': 'Submit the daily close',
  'expense.create': 'Log expenses',
  'purchase.create': 'Log purchases (stock in)',
  'supplier.manage': 'Add and edit suppliers',
  'supplier.pay': 'Pay suppliers / settle credit',
  'inventory.view': 'See stock levels',
  'inventory.manage': 'Edit stock items, recipes and mixes',
  'inventory.count': 'Do the weekly stock count',
  'inventory.waste': 'Record waste and losses',
  'inventory.request': 'Raise stock requests',
  'menu.manage': 'Edit menu, prices, sizes, deals and taxes',
  'finance.view': 'See money accounts, ledger and balances',
  'accounts.manage': 'Add and edit money accounts and account heads',
  'capital.manage': 'Record investments, loans and advances',
  'capital.withdraw': 'Request withdrawals and payouts',
  'partners.manage': 'Propose partner and share changes',
  'payroll.manage': 'Manage employees and pay wages',
  'reports.view': 'See operational reports',
  'reports.partners': 'See partner share and capital reports',
  'investor.portal': 'Use the investor portal',
  'approve.expense': 'Approve spends above the limit',
  'approve.purchase': 'Approve purchases above the limit',
  'approve.supplier_credit': 'Approve taking supplier credit',
  'approve.day_close': 'Approve the daily close (locks the day)',
  'approve.withdrawal': 'Approve withdrawals and payouts',
  'approve.refund': 'Approve customer refunds',
  'approve.loan_refund': 'Approve refunding a loan',
  'approve.partner_change': 'Approve adding a partner or changing shares',
  'comment.create': 'Ask questions and comment on entries',
  'users.manage': 'Add people and users, reset passwords',
  'roles.manage': 'Edit roles, scopes and individual rights',
  'settings.manage': 'Organization and location settings, notification rules',
  'audit.view': 'See the audit trail',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(p: string): p is Permission {
  return p === '*' || p in PERMISSIONS;
}

/** Approval kinds and the permission that routes a request to its approvers. */
export const APPROVAL_KINDS = {
  expense: 'approve.expense',
  purchase: 'approve.purchase',
  supplier_credit: 'approve.supplier_credit',
  day_close: 'approve.day_close',
  withdrawal: 'approve.withdrawal',
  refund: 'approve.refund',
  loan_refund: 'approve.loan_refund',
  partner_change: 'approve.partner_change',
} as const satisfies Record<string, Permission>;

export type ApprovalKind = keyof typeof APPROVAL_KINDS;

export interface Grant {
  permissions: string[];
  allOrgs: boolean;
  orgIds: string[];
  locationIds: string[];
}

export interface Override {
  permission: string;
  orgId: string | null;
  effect: 'grant' | 'deny';
}

/**
 * Resolved access for one user. Deny overrides beat everything; grant overrides add a right;
 * otherwise a role must cover the permission within its org (and optional location) scope.
 */
export class Access {
  constructor(
    readonly grants: Grant[],
    readonly overrides: Override[],
    readonly isPlatformOwner = false,
  ) {}

  can(permission: Permission, orgId: string, locationId?: string | null): boolean {
    const denied = this.overrides.some(
      (o) => o.effect === 'deny' && o.permission === permission && (o.orgId === null || o.orgId === orgId),
    );
    if (denied) return false;
    const granted = this.overrides.some(
      (o) => o.effect === 'grant' && o.permission === permission && (o.orgId === null || o.orgId === orgId),
    );
    if (granted) return true;
    return this.grants.some((g) => {
      if (!(g.permissions.includes('*') || g.permissions.includes(permission))) return false;
      if (!(g.allOrgs || g.orgIds.includes(orgId))) return false;
      if (locationId && g.locationIds.length > 0 && !g.locationIds.includes(locationId)) return false;
      return true;
    });
  }

  /** Org ids where the user holds any role (for org pickers). */
  orgIds(allTenantOrgIds: string[]): string[] {
    if (this.grants.some((g) => g.allOrgs)) return allTenantOrgIds;
    const set = new Set<string>();
    for (const g of this.grants) for (const id of g.orgIds) set.add(id);
    for (const o of this.overrides) if (o.effect === 'grant' && o.orgId) set.add(o.orgId);
    return allTenantOrgIds.filter((id) => set.has(id));
  }

  /** Locations within an org the user may act in; null = all of them. */
  locationScope(orgId: string): string[] | null {
    const relevant = this.grants.filter((g) => g.allOrgs || g.orgIds.includes(orgId));
    if (relevant.some((g) => g.locationIds.length === 0)) return null;
    const set = new Set<string>();
    for (const g of relevant) for (const id of g.locationIds) set.add(id);
    return [...set];
  }

  /** Every permission the user effectively holds in an org (for the UI to show/hide actions). */
  effective(orgId: string): Permission[] {
    return ALL_PERMISSIONS.filter((p) => this.can(p, orgId));
  }
}
