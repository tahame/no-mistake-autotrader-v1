// Composition root: the only place that connects modules to each other.
import * as approvals from './modules/approvals/index.js';
import * as catalog from './modules/catalog/index.js';
import * as finance from './modules/finance/index.js';
import * as inventory from './modules/inventory/index.js';
import * as orders from './modules/orders/index.js';
import * as reporting from './modules/reporting/index.js';
import * as tenancy from './modules/tenancy/index.js';

let wired = false;

export function wire() {
  if (wired) return;
  wired = true;
  finance.registerFinance();

  // Order management reaches the rest of the platform only through these ports.
  orders.configureOrders({
    openDay: (tx, locationId) => finance.openDayFor(tx, locationId),
    assertLocation: async (tx, orgId, locationId) => {
      await tenancy.assertLocationInOrg(tx, orgId, locationId);
    },
    priceLines: (tx, orgId, locationId, lines) => catalog.priceLines(tx, orgId, locationId, lines),
    taxes: (tx, orgId) => catalog.enabledTaxes(tx, orgId),
    paymentAccount: (tx, orgId, id) => finance.moneyAccount(tx, orgId, id),
    defaultCashAccount: (tx, orgId, locationId) => finance.defaultCashAccount(tx, orgId, locationId),
    requestApproval: (ctx, input) => approvals.requestApproval(ctx, input),
    registerApprovalHandler: (type, h) => approvals.registerApprovalHandler(type, h),
  });

  // Consumers of order events. Each is idempotent and runs in its own transaction.
  orders.subscribe('finance.sales', ['order.completed', 'order.voided', 'order.refund_approved'], async (tx, e) => {
    if (e.type === 'order.completed') await finance.salesLedger.onOrderCompleted(tx, e);
    else if (e.type === 'order.voided') await finance.salesLedger.onOrderVoided(tx, e);
    else await finance.salesLedger.onRefundApproved(tx, e);
  });
  orders.subscribe('inventory.depletion', ['order.completed', 'order.voided'], async (tx, e) => {
    if (e.type === 'order.completed') await inventory.onOrderCompleted(tx, e);
    else if (e.type === 'order.voided') await inventory.onOrderVoided(tx, e);
  });
  orders.subscribe('reporting.sales', ['order.completed', 'order.voided'], async (tx, e) => {
    if (e.type === 'order.completed') await reporting.onOrderCompleted(tx, e);
    else if (e.type === 'order.voided') await reporting.onOrderVoided(tx, e);
  });

  // A day cannot close until every sale in it has reached the books and stock.
  finance.addCloseGuard(async (tx, dayId) => {
    const p = await orders.pendingForDay(tx, dayId);
    if (p.count === 0) return null;
    return `${p.count} sale event(s) are still being processed${p.lastError ? ` (error: ${p.lastError})` : ''}. Try again in a moment.`;
  });
}
