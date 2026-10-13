// Public API of the order management module. This module imports nothing from other modules:
// it depends only on core/, db/, the event contract and its ports, so it can be split out.
import { onRefundApproved, onRefundRejected } from './service.js';
import { configurePorts, type OrdersPorts } from './ports.js';

export { computeTotals, createOrder, voidOrder, requestRefund, listOrders, type NewOrder } from './service.js';
export { subscribe, dispatchPending, pendingForDay } from './outbox.js';
export type { OrdersPorts, PricedLine, TaxRate } from './ports.js';

export function configureOrders(p: OrdersPorts) {
  configurePorts(p);
  p.registerApprovalHandler('refund', { onApproved: onRefundApproved, onRejected: onRefundRejected });
}
