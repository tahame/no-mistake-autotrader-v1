import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../core/context.js';
import { run } from '../../http/run.js';
import { date, id, minor, orgIdParams, orgParams, positiveMinor, qty, typed } from '../../http/schemas.js';
import * as accounts from './accounts.js';
import * as capital from './capital.js';
import * as days from './days.js';
import * as partners from './partners.js';
import * as payroll from './payroll.js';
import * as spend from './spend.js';

const moneyKind = z.enum(['cash', 'easypaisa', 'jazzcash', 'nayapay', 'sadapay', 'bank', 'other']);

export async function financeRoutes(base: FastifyInstance) {
  const app = typed(base);
  const fin = { module: 'finance' };

  // ---- Money accounts, account heads, transfers, suppliers ----
  app.get('/orgs/:orgId/money-accounts', { schema: { tags: ['money'], params: orgParams } }, (req) =>
    run(req, (ctx) => accounts.listMoneyAccounts(ctx, req.params.orgId, { withBalances: ctx.access.can('finance.view', req.params.orgId) })));

  app.post('/orgs/:orgId/money-accounts', {
    schema: { tags: ['money'], params: orgParams, body: z.object({ name: z.string().min(2).max(80), kind: moneyKind, locationId: id.nullable().optional(),
      ownerPersonId: id.nullable().optional() }) },
  }, (req) => run(req, (ctx) => accounts.createMoneyAccount(ctx, req.params.orgId, req.body), fin));

  app.patch('/orgs/:orgId/money-accounts/:id', {
    schema: { tags: ['money'], params: orgIdParams, body: z.object({ name: z.string().min(2).max(80).optional(), ownerPersonId: id.nullable().optional(),
      locationId: id.nullable().optional(), active: z.boolean().optional() }) },
  }, (req) => run(req, (ctx) => accounts.updateMoneyAccount(ctx, req.params.orgId, req.params.id, req.body), fin));

  app.get('/orgs/:orgId/money-accounts/:id/statement', { schema: { tags: ['money'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => accounts.accountStatement(ctx, req.params.orgId, req.params.id), fin));

  app.post('/orgs/:orgId/transfers', {
    schema: { tags: ['money'], params: orgParams, body: z.object({ fromAccountId: id, toAccountId: id, amountMinor: positiveMinor, note: z.string().max(200).optional(),
      locationId: id.nullable().optional() }) },
  }, (req) => run(req, async (ctx) => {
    const day = req.body.locationId ? await days.openDayFor(ctx.tx, req.body.locationId) : null;
    return accounts.transfer(ctx, req.params.orgId, { ...req.body, businessDayId: day?.id ?? null });
  }, fin));

  app.get('/orgs/:orgId/ledger-heads', { schema: { tags: ['money'], params: orgParams } }, (req) =>
    run(req, (ctx) => accounts.ledgerHeads(ctx, req.params.orgId)));

  app.post('/orgs/:orgId/ledger-heads', { schema: { tags: ['money'], params: orgParams, body: z.object({ name: z.string().min(2).max(80) }) } }, (req) =>
    run(req, (ctx) => accounts.addExpenseHead(ctx, req.params.orgId, req.body), fin));

  app.get('/orgs/:orgId/suppliers', { schema: { tags: ['suppliers'], params: orgParams } }, (req) =>
    run(req, (ctx) => accounts.listSuppliers(ctx, req.params.orgId)));

  app.post('/orgs/:orgId/suppliers', {
    schema: { tags: ['suppliers'], params: orgParams, body: z.object({ id: id.optional(), name: z.string().min(2).max(80), phone: z.string().max(30).nullable().optional(),
      notes: z.string().max(500).nullable().optional(), active: z.boolean().optional() }) },
  }, (req) => run(req, (ctx) => accounts.upsertSupplier(ctx, req.params.orgId, req.body)));

  app.post('/orgs/:orgId/suppliers/:id/pay', {
    schema: { tags: ['suppliers'], params: orgIdParams, body: z.object({ amountMinor: positiveMinor, moneyAccountId: id, locationId: id.nullable().optional(),
      note: z.string().max(200).optional() }) },
  }, (req) => run(req, (ctx) => spend.paySupplier(ctx, req.params.orgId, { ...req.body, supplierId: req.params.id }), fin));

  // ---- Business day ----
  app.get('/orgs/:orgId/days', { schema: { tags: ['day'], params: orgParams, querystring: z.object({ locationId: id.optional() }) } }, (req) =>
    run(req, (ctx) => days.listDays(ctx, req.params.orgId, req.query.locationId ?? null)));

  app.get('/orgs/:orgId/days/current', { schema: { tags: ['day'], params: orgParams, querystring: z.object({ locationId: id }) } }, (req) =>
    run(req, async (ctx) => {
      requirePerm(ctx, 'pos.sell', req.params.orgId, req.query.locationId);
      const day = await days.openDayFor(ctx.tx, req.query.locationId);
      const [pending] = await ctx.tx<{ id: string; business_date: string }[]>`select id, business_date from finance.business_days
        where location_id = ${req.query.locationId} and status = 'submitted' order by business_date desc limit 1`;
      return { day, figures: day ? await days.dayFigures(ctx.tx, day.id) : null, drawer: await days.drawerBalance(ctx.tx, req.params.orgId, req.query.locationId),
        awaitingApproval: pending ?? null };
    }));

  app.get('/orgs/:orgId/days/:id', { schema: { tags: ['day'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => days.dayDetail(ctx, req.params.orgId, req.params.id)));

  app.post('/orgs/:orgId/days/open', {
    schema: { tags: ['day'], params: orgParams, body: z.object({ locationId: id, openingFloatMinor: minor, floatAccountId: id.optional(),
      floatSource: z.discriminatedUnion('kind', [z.object({ kind: z.literal('account'), accountId: id }), z.object({ kind: z.literal('investment'), personId: id })]).nullable().optional(),
      note: z.string().max(500).optional() }) },
  }, (req) => run(req, (ctx) => days.openDay(ctx, req.params.orgId, req.body)));

  app.get('/orgs/:orgId/days/:id/close-preview', { schema: { tags: ['day'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => days.closePreview(ctx, req.params.orgId, req.params.id)));

  app.post('/orgs/:orgId/days/:id/close', {
    schema: { tags: ['day'], params: orgIdParams, body: z.object({
      declared: z.array(z.object({ moneyAccountId: id, declaredMinor: z.number().int() })),
      transfers: z.array(z.object({ fromAccountId: id, toAccountId: id, amountMinor: positiveMinor, note: z.string().max(200).optional() })).default([]),
      note: z.string().max(1000).optional() }) },
  }, (req) => run(req, (ctx) => days.submitClose(ctx, req.params.orgId, req.params.id, req.body)));

  // ---- Expenses and purchases ----
  app.get('/orgs/:orgId/expenses', { schema: { tags: ['spend'], params: orgParams, querystring: z.object({ locationId: id.optional(), from: date.optional(), to: date.optional() }) } },
    (req) => run(req, (ctx) => spend.listExpenses(ctx, req.params.orgId, req.query), fin));

  app.post('/orgs/:orgId/expenses', {
    schema: { tags: ['spend'], params: orgParams, body: z.object({ locationId: id.nullable().optional(), categoryAccountId: id, amountMinor: positiveMinor,
      payment: z.enum(['paid', 'credit']), moneyAccountId: id.nullable().optional(), supplierId: id.nullable().optional(), payee: z.string().max(120).nullable().optional(),
      description: z.string().min(2).max(500) }) },
  }, (req) => run(req, (ctx) => spend.createExpense(ctx, req.params.orgId, req.body), fin));

  app.get('/orgs/:orgId/purchases', { schema: { tags: ['spend'], params: orgParams, querystring: z.object({ locationId: id.optional() }) } }, (req) =>
    run(req, (ctx) => spend.listPurchases(ctx, req.params.orgId, req.query), fin));

  app.post('/orgs/:orgId/purchases', {
    schema: { tags: ['spend'], params: orgParams, body: z.object({ locationId: id, supplierId: id, payment: z.enum(['paid', 'credit']),
      moneyAccountId: id.nullable().optional(), note: z.string().max(500).nullable().optional(),
      lines: z.array(z.object({ itemId: id, qty, unit: z.string(), totalMinor: positiveMinor })).min(1) }) },
  }, (req) => run(req, (ctx) => spend.createPurchase(ctx, req.params.orgId, req.body), fin));

  app.get('/orgs/:orgId/stock-items/:id/prices', { schema: { tags: ['spend'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => spend.priceHistory(ctx, req.params.orgId, req.params.id), fin));

  // ---- Capital, loans, withdrawals ----
  app.get('/orgs/:orgId/capital', { schema: { tags: ['capital'], params: orgParams, querystring: z.object({ personId: id.optional() }) } }, (req) =>
    run(req, async (ctx) => ({
      ...(await capital.listCapital(ctx, req.params.orgId, req.query.personId)),
      positions: await capital.capitalPositions(ctx, req.params.orgId, req.query.personId),
    }), fin));

  const capitalBody = z.object({ personId: id, amountMinor: positiveMinor, moneyAccountId: id, locationId: id.nullable().optional(), reason: z.string().max(500).optional() });

  app.post('/orgs/:orgId/capital/investments', { schema: { tags: ['capital'], params: orgParams, body: capitalBody } }, (req) =>
    run(req, (ctx) => capital.recordInvestment(ctx, req.params.orgId, req.body), fin));

  app.post('/orgs/:orgId/capital/loans', { schema: { tags: ['capital'], params: orgParams, body: capitalBody.extend({ dueDate: date.nullable().optional() }) } }, (req) =>
    run(req, (ctx) => capital.recordLoan(ctx, req.params.orgId, req.body), fin));

  app.post('/orgs/:orgId/capital/loans/:id/convert', {
    schema: { tags: ['capital'], params: orgIdParams, body: z.object({ amountMinor: positiveMinor, reason: z.string().min(2).max(500) }) },
  }, (req) => run(req, (ctx) => capital.convertLoan(ctx, req.params.orgId, req.params.id, req.body), fin));

  app.post('/orgs/:orgId/capital/loans/:id/refund', {
    schema: { tags: ['capital'], params: orgIdParams, body: z.object({ amountMinor: positiveMinor, moneyAccountId: id, reason: z.string().max(500).optional() }) },
  }, (req) => run(req, (ctx) => capital.requestLoanRefund(ctx, req.params.orgId, req.params.id, req.body), fin));

  app.post('/orgs/:orgId/capital/refunds/:id/confirm', { schema: { tags: ['capital'], params: orgIdParams } }, (req) =>
    run(req, (ctx) => capital.confirmLoanRefund(ctx, req.params.orgId, req.params.id), fin));

  app.post('/orgs/:orgId/capital/withdrawals', { schema: { tags: ['capital'], params: orgParams, body: capitalBody } }, (req) =>
    run(req, (ctx) => capital.requestWithdrawal(ctx, req.params.orgId, req.body), fin));

  app.post('/orgs/:orgId/capital/reinvest', {
    schema: { tags: ['capital'], params: orgParams, body: z.object({ personId: id, amountMinor: positiveMinor, locationId: id.nullable().optional(), reason: z.string().max(500).optional() }) },
  }, (req) => run(req, (ctx) => capital.reinvest(ctx, req.params.orgId, req.body), fin));

  app.post('/orgs/:orgId/capital/advances', {
    schema: { tags: ['capital'], params: orgParams, body: z.object({ personId: id, amountMinor: positiveMinor, moneyAccountId: id, direction: z.enum(['take', 'repay']),
      reason: z.string().max(500).optional() }) },
  }, (req) => run(req, (ctx) => capital.recordAdvance(ctx, req.params.orgId, req.body), fin));

  // ---- Partners and investors ----
  app.get('/orgs/:orgId/partners', { schema: { tags: ['partners'], params: orgParams } }, (req) =>
    run(req, (ctx) => partners.listPartners(ctx, req.params.orgId)));

  app.post('/orgs/:orgId/partners/proposals', {
    schema: { tags: ['partners'], params: orgParams, body: z.object({ shares: z.array(z.object({ personId: id, weight: z.number().positive() })).min(1),
      effectiveFrom: date, reason: z.string().max(500).optional(), mode: z.enum(['percent', 'ratio']) }) },
  }, (req) => run(req, (ctx) => partners.proposeShares(ctx, req.params.orgId, req.body)));

  app.post('/orgs/:orgId/investors/terms', {
    schema: { tags: ['partners'], params: orgParams, body: z.object({ personId: id, takesReturn: z.boolean(), returnWeight: z.number().min(0),
      mentorship: z.boolean(), effectiveFrom: date }) },
  }, (req) => run(req, (ctx) => partners.setInvestorTerms(ctx, req.params.orgId, req.body)));

  app.get('/orgs/:orgId/partners/statement', { schema: { tags: ['partners'], params: orgParams, querystring: z.object({ from: date, to: date, personId: id.optional() }) } }, (req) =>
    run(req, (ctx) => partners.partnerStatement(ctx, req.params.orgId, req.query.from, req.query.to, req.query.personId)));

  // ---- Employees and wages ----
  app.get('/orgs/:orgId/employees', { schema: { tags: ['payroll'], params: orgParams } }, (req) =>
    run(req, (ctx) => payroll.listEmployees(ctx, req.params.orgId), fin));

  app.post('/orgs/:orgId/employees', {
    schema: { tags: ['payroll'], params: orgParams, body: z.object({ id: id.optional(), personId: id, locationId: id.nullable().optional(), title: z.string().min(2).max(60),
      payType: z.enum(['monthly', 'daily', 'hourly', 'none']), payRateMinor: minor, commissionEnabled: z.boolean(),
      commissionBps: z.number().int().min(0).max(10000), active: z.boolean().optional(), startedOn: date.nullable().optional(), endedOn: date.nullable().optional() }) },
  }, (req) => run(req, (ctx) => payroll.upsertEmployee(ctx, req.params.orgId, req.body), fin));

  app.get('/orgs/:orgId/wages', { schema: { tags: ['payroll'], params: orgParams } }, (req) =>
    run(req, (ctx) => payroll.listWagePayments(ctx, req.params.orgId), fin));

  app.post('/orgs/:orgId/wages', {
    schema: { tags: ['payroll'], params: orgParams, body: z.object({ employeeId: id, units: qty, commissionMinor: minor, moneyAccountId: id,
      periodFrom: date.nullable().optional(), periodTo: date.nullable().optional(), note: z.string().max(300).optional() }) },
  }, (req) => run(req, (ctx) => payroll.payWages(ctx, req.params.orgId, req.body), fin));
}
