// Published event contract of the order management module. Consumers (inventory, finance,
// reporting) depend only on these shapes, never on orders' tables or code — so orders can
// move to its own server and deliver the same events over a queue instead of the outbox.

export interface OrderLineEvent {
  lineId: string;
  menuItemId: string;
  variantId: string;
  itemName: string;
  variantName: string;
  categoryName: string;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  modifiers: { id: string; name: string; priceDeltaMinor: number }[];
}

export interface TaxLine {
  name: string;
  rateBps: number;
  inclusive: boolean;
  amountMinor: number;
}

interface Base {
  eventId: string;
  tenantId: string;
  orgId: string;
  locationId: string;
  orderId: string;
}

export interface OrderCompleted extends Base {
  type: 'order.completed';
  orderNo: number;
  businessDayId: string;
  businessDate: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxLines: TaxLine[];
  paymentAccountId: string;
  paymentKind: string;
  createdBy: string;
  createdAt: string;
  lines: OrderLineEvent[];
}

export interface OrderVoided extends Base {
  type: 'order.voided';
  businessDayId: string;
  businessDate: string;
  reason: string;
  voidedBy: string;
}

export interface RefundApproved extends Base {
  type: 'order.refund_approved';
  refundId: string;
  amountMinor: number;
  accountId: string;
  reason: string;
  approvedBy: string;
}

export type OrderEvent = OrderCompleted | OrderVoided | RefundApproved;
