// Public API of the finance module: money accounts, business days, spending, capital, partners,
// payroll, and the ledger side of sales.
import { registerApprovalHandler } from '../approvals/index.js';
import { createDefaultChart } from '../ledger/index.js';
import { onLocationCreated, onOrgCreated } from '../tenancy/index.js';
import { setupLocationAccounts } from './accounts.js';
import { onCapitalApproved, onCapitalRejected } from './capital.js';
import { approveClose, rejectClose } from './days.js';
import { applyShareProposal, rejectShareProposal } from './partners.js';
import { postExpense, postPurchase, rejectExpense, rejectPurchase } from './spend.js';

export {
  createMoneyAccount, createMoneyAccountRaw, updateMoneyAccount, moneyAccount, listMoneyAccounts, ledgerHeads, addExpenseHead,
  transfer, accountStatement, listSuppliers, upsertSupplier, defaultCashAccount,
} from './accounts.js';
export { addCloseGuard, openDayFor, getDay, openDay, dayFigures, closePreview, submitClose, listDays, dayDetail, type DayRow } from './days.js';
export { createExpense, listExpenses, createPurchase, listPurchases, priceHistory, paySupplier } from './spend.js';
export {
  recordInvestment, recordLoan, convertLoan, requestLoanRefund, confirmLoanRefund, requestWithdrawal, reinvest, recordAdvance,
  listCapital, capitalPositions,
} from './capital.js';
export { listPartners, proposeShares, setInvestorTerms, partnerStatement, partnerUserIds, earnedByPerson, sharesOn } from './partners.js';
export { listEmployees, upsertEmployee, payWages, listWagePayments } from './payroll.js';
export * as salesLedger from './sales.js';

let registered = false;
/** Wire finance into approvals and org/location setup. Called once by the composition root. */
export function registerFinance() {
  if (registered) return;
  registered = true;
  onOrgCreated(createDefaultChart);
  onLocationCreated((tx, tenantId, orgId, locationId, name) => setupLocationAccounts(tx, tenantId, orgId, locationId, name));
  registerApprovalHandler('expense', { onApproved: (ctx, id) => postExpense(ctx, id), onRejected: (ctx, id) => rejectExpense(ctx, id) });
  registerApprovalHandler('purchase', { onApproved: (ctx, id) => postPurchase(ctx, id), onRejected: (ctx, id) => rejectPurchase(ctx, id) });
  registerApprovalHandler('business_day', { onApproved: (ctx, id) => approveClose(ctx, id), onRejected: (ctx, id) => rejectClose(ctx, id) });
  registerApprovalHandler('capital_txn', { onApproved: (ctx, id) => onCapitalApproved(ctx, id), onRejected: (ctx, id) => onCapitalRejected(ctx, id) });
  registerApprovalHandler('share_proposal', { onApproved: (ctx, id) => applyShareProposal(ctx, id), onRejected: (ctx, id) => rejectShareProposal(ctx, id) });
}
