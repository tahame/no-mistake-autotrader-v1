import type { Ctx } from '../../core/context.js';
import type { Tx } from '../../db/db.js';

// Everything order management needs from the rest of the platform, as an interface.
// In the monolith these are wired to the other modules in-process (see wiring.ts); when orders
// moves to its own server, the same interface is implemented with API calls.

export interface PricedLine {
  variantId: string;
  menuItemId: string;
  itemName: string;
  variantName: string;
  categoryName: string;
  qty: number;
  unitPriceMinor: number;
  modifiers: { id: string; name: string; priceDeltaMinor: number }[];
  lineTotalMinor: number;
}

export interface TaxRate {
  name: string;
  rate_bps: number;
  applies_to: 'all' | 'card';
  inclusive: boolean;
}

export interface OrdersPorts {
  openDay(tx: Tx, locationId: string): Promise<{ id: string; business_date: string } | null>;
  assertLocation(tx: Tx, orgId: string, locationId: string): Promise<void>;
  priceLines(tx: Tx, orgId: string, locationId: string,
    lines: { variantId: string; qty: number; modifierIds?: string[]; openPriceMinor?: number }[]): Promise<PricedLine[]>;
  taxes(tx: Tx, orgId: string): Promise<TaxRate[]>;
  paymentAccount(tx: Tx, orgId: string, accountId: string): Promise<{ id: string; kind: string; name: string }>;
  defaultCashAccount(tx: Tx, orgId: string, locationId: string): Promise<string | null>;
  requestApproval(ctx: Ctx, input: { orgId: string; locationId: string; kind: 'refund'; subjectType: string; subjectId: string;
    summary: string; amountMinor: number }): Promise<string>;
  registerApprovalHandler(subjectType: string, handler: {
    onApproved(ctx: Ctx, subjectId: string): Promise<void>;
    onRejected(ctx: Ctx, subjectId: string): Promise<void>;
  }): void;
}

let current: OrdersPorts | undefined;

export function configurePorts(p: OrdersPorts) {
  current = p;
}

export function ports(): OrdersPorts {
  if (!current) throw new Error('orders module ports are not configured');
  return current;
}
