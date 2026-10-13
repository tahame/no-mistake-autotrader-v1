import type { OrderCompleted, OrderVoided, RefundApproved } from '../../contracts/order-events.js';
import type { Tx } from '../../db/db.js';
import { accountId, findEntry, postEntry, reverseEntry } from '../ledger/index.js';
import { getOrg, localDate } from '../tenancy/index.js';
import { openDayFor } from './days.js';

// Order events -> the books. A sale is money in the account it was paid into, split between
// sales and any tax collected. A void mirrors it exactly. An approved refund is money out.

async function ledgerFor(tx: Tx, moneyAccountId: string) {
  const [m] = await tx<{ ledger_account_id: string }[]>`select ledger_account_id from finance.money_accounts where id = ${moneyAccountId}`;
  if (!m) throw new Error(`money account ${moneyAccountId} not found`);
  return m.ledger_account_id;
}

export async function onOrderCompleted(tx: Tx, e: OrderCompleted) {
  const net = e.totalMinor - e.taxMinor;
  await postEntry(tx, {
    tenantId: e.tenantId, orgId: e.orgId, locationId: e.locationId, businessDayId: e.businessDayId, entryDate: e.businessDate,
    memo: `Sale #${e.orderNo}`, sourceType: 'order', sourceId: e.orderId, createdBy: e.createdBy,
    lines: [
      { account: await ledgerFor(tx, e.paymentAccountId), debit: e.totalMinor, moneyAccountId: e.paymentAccountId },
      { account: await accountId(tx, e.orgId, 'sales'), credit: net },
      { account: await accountId(tx, e.orgId, 'tax_payable'), credit: e.taxMinor },
    ],
  });
}

export async function onOrderVoided(tx: Tx, e: OrderVoided) {
  const entryId = await findEntry(tx, 'order', e.orderId);
  if (!entryId) return;
  await reverseEntry(tx, entryId, { memo: `Void: ${e.reason}`, sourceType: 'order_void', sourceId: e.orderId, businessDayId: e.businessDayId,
    entryDate: e.businessDate, createdBy: e.voidedBy });
}

export async function onRefundApproved(tx: Tx, e: RefundApproved) {
  const org = await getOrg(tx, e.orgId);
  const day = await openDayFor(tx, e.locationId);
  await postEntry(tx, {
    tenantId: e.tenantId, orgId: e.orgId, locationId: e.locationId, businessDayId: day?.id ?? null, entryDate: day?.business_date ?? localDate(org.timezone),
    memo: `Refund: ${e.reason}`, sourceType: 'refund', sourceId: e.refundId, createdBy: e.approvedBy,
    lines: [
      { account: await accountId(tx, e.orgId, 'sales_returns'), debit: e.amountMinor },
      { account: await ledgerFor(tx, e.accountId), credit: e.amountMinor, moneyAccountId: e.accountId },
    ],
  });
}
