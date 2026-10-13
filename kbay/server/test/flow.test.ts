import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { closeDb, withSystem, withTenant } from '../src/db/db.js';
import { dispatchPending } from '../src/modules/orders/index.js';
import { verifyAuditChain } from '../src/modules/owner/index.js';
import { seed } from '../src/seed/seed.js';

// End to end through the real API: a full trading day at K-Bay Stall 1, the approvals, the close,
// and the money, stock and partner numbers that must come out of it.

let app: FastifyInstance;
const cookies: Record<string, string> = {};
const pw: Record<string, string> = {};
let orgId = '';
let stallId = '';
const acct: Record<string, string> = {};
const stock: Record<string, string> = {};
const supplier: Record<string, string> = {};
const variant: Record<string, string> = {};
const modifier: Record<string, string> = {};
const people: Record<string, string> = {};

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
async function call(user: string, method: Method, url: string, body?: unknown) {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body as never, cookies: cookies[user] ? { kbay_session: cookies[user]! } : {} });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
async function ok(user: string, method: Method, url: string, body?: unknown) {
  const r = await call(user, method, url, body);
  if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const rs = (rupees: number) => Math.round(rupees * 100);

async function login(user: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: user, password } });
  expect(res.statusCode).toBe(200);
  cookies[user] = res.cookies.find((c) => c.name === 'kbay_session')!.value;
  return JSON.parse(res.body);
}

beforeAll(async () => {
  const r = await seed(() => {});
  for (const c of r.credentials) pw[c.username] = c.password;
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe('first sign-in', () => {
  it('forces each person to set their own password', async () => {
    const r = await login('shahzaib', pw.shahzaib!);
    expect(r.mustChangePassword).toBe(true);
    const blocked = await call('shahzaib', 'GET', '/notifications');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('password_change_required');
    expect((await call('shahzaib', 'POST', '/auth/password', { current: pw.shahzaib, next: 'kbay-2' })).status).toBe(400);
    await ok('shahzaib', 'POST', '/auth/password', { current: pw.shahzaib, next: 'shazi-fries-2026' });
    for (const u of ['taha', 'visam', 'adil']) {
      await login(u, pw[u]!);
      await ok(u, 'POST', '/auth/password', { current: pw[u], next: `${u}-own-password-1` });
    }
  });

  it('rejects a wrong password', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'adil', password: 'nope' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('workspace and seeded data', () => {
  it('shows K-BAY under OPPLOX with one stall', async () => {
    const w = await ok('shahzaib', 'GET', '/workspace');
    expect(w.tenant.name).toBe('OPPLOX');
    expect(w.orgs).toHaveLength(1);
    expect(w.orgs[0].brand_name).toBe('K-BAY');
    orgId = w.orgs[0].id;
    stallId = w.orgs[0].locations[0].id;
    expect(w.orgs[0].locations[0].approval_limit_minor).toBe(200000);
    expect(w.orgs[0].permissions).toContain('pos.sell');
    expect(w.orgs[0].permissions).not.toContain('approve.withdrawal');
  });

  it('has accounts, suppliers, stock items and the menu', async () => {
    for (const a of await ok('taha', 'GET', `/orgs/${orgId}/money-accounts`)) acct[a.kind === 'cash' ? 'drawer' : a.kind] = a.id;
    expect(Object.keys(acct).sort()).toEqual(['bank', 'drawer', 'easypaisa']);
    for (const s of await ok('taha', 'GET', `/orgs/${orgId}/suppliers`)) supplier[s.name.split(' ')[0].toLowerCase()] = s.id;
    for (const i of await ok('taha', 'GET', `/orgs/${orgId}/stock-items`)) stock[i.name] = i.id;
    expect(stock['Potato — Santos']).toBeTruthy();
    const menu = await ok('shahzaib', 'GET', `/orgs/${orgId}/menu?locationId=${stallId}`);
    // Only fries are switched on today.
    expect(menu.map((c: { name: string }) => c.name)).toEqual(['Fries']);
    for (const c of menu) for (const i of c.items) {
      for (const v of i.variants) variant[`${i.name}|${v.name}`] = v.id;
      for (const g of i.modifierGroups) for (const m of g.modifiers) modifier[m.name] = m.id;
    }
    expect(variant['Salted Fries|Rs 100']).toBeTruthy();
    expect(variant['Salted Fries|Rs 300']).toBeUndefined(); // seeded but switched off
    const full = await ok('taha', 'GET', `/orgs/${orgId}/menu?all=true`);
    expect(full.length).toBeGreaterThanOrEqual(8);
    const ppl = await ok('taha', 'GET', `/orgs/${orgId}/people`);
    for (const p of ppl) people[p.username] = p.id;
  });

  it('has the agreed partner split and investor terms', async () => {
    const p = await ok('taha', 'GET', `/orgs/${orgId}/partners`);
    expect(p.current.map((s: { name: string; percent: number }) => [s.name, s.percent]).sort()).toEqual([['Adil', 33.33], ['KB (Shazi)', 33.33], ['Visam', 33.33]]);
    expect(p.investors[0].takes_return).toBe(false);
    expect(p.investors[0].mentorship).toBe(true);
  });
});

describe('a trading day', () => {
  let dayId = '';
  const orders: string[] = [];

  it('cannot sell before the day is open', async () => {
    const r = await call('shahzaib', 'POST', `/orgs/${orgId}/orders`, { locationId: stallId, lines: [{ variantId: variant['Salted Fries|Rs 100'], qty: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('day_not_open');
  });

  it('opens with a float invested by Taha', async () => {
    const r = await ok('shahzaib', 'POST', `/orgs/${orgId}/days/open`, { locationId: stallId, openingFloatMinor: rs(1000),
      floatSource: { kind: 'investment', personId: people.taha } });
    dayId = r.id;
    const cur = await ok('shahzaib', 'GET', `/orgs/${orgId}/days/current?locationId=${stallId}`);
    expect(cur.drawer.balance).toBe(rs(1000));
    expect((await call('shahzaib', 'POST', `/orgs/${orgId}/days/open`, { locationId: stallId, openingFloatMinor: 0 })).status).toBe(409);
  });

  it('logs purchases: small ones post, big ones and credit wait for a partner', async () => {
    const small = await ok('shahzaib', 'POST', `/orgs/${orgId}/purchases`, { locationId: stallId, supplierId: supplier.sabzi, payment: 'paid',
      moneyAccountId: acct.easypaisa, lines: [{ itemId: stock['Potato — Santos'], qty: '20', unit: 'kg', totalMinor: rs(2000) }] });
    expect(small.status).toBe('posted'); // exactly at the Rs 2,000 limit
    const big = await ok('shahzaib', 'POST', `/orgs/${orgId}/purchases`, { locationId: stallId, supplierId: supplier['cash'], payment: 'paid',
      moneyAccountId: acct.easypaisa, lines: [
        { itemId: stock['Cooking oil'], qty: '5', unit: 'l', totalMinor: rs(2750) },
        { itemId: stock['Fries box'], qty: '100', unit: 'unit', totalMinor: rs(500) },
        { itemId: stock['Ketchup sachet'], qty: '2', unit: 'dozen', totalMinor: rs(120) },
        { itemId: stock['Corn flour'], qty: '1000', unit: 'g', totalMinor: rs(300) },
      ] });
    expect(big.status).toBe('pending_approval');
    // You cannot approve your own request.
    expect((await call('shahzaib', 'POST', `/orgs/${orgId}/approvals/${big.approvalId}/decide`, { decision: 'approve' })).status).toBe(403);
    await ok('visam', 'POST', `/orgs/${orgId}/approvals/${big.approvalId}/decide`, { decision: 'approve' });
    const credit = await ok('shahzaib', 'POST', `/orgs/${orgId}/purchases`, { locationId: stallId, supplierId: supplier.gas, payment: 'credit',
      lines: [{ itemId: stock['Gas (LPG)'], qty: '11.8', unit: 'kg', totalMinor: rs(3200) }] });
    expect(credit.status).toBe('pending_approval');
    await ok('adil', 'POST', `/orgs/${orgId}/approvals/${credit.approvalId}/decide`, { decision: 'approve' });
    const sups = await ok('taha', 'GET', `/orgs/${orgId}/suppliers`);
    expect(sups.find((s: { id: string }) => s.id === supplier.gas).owed_minor).toBe(rs(3200));
  });

  it('a group item (Potato) cannot be bought — only a named variety', async () => {
    const r = await call('shahzaib', 'POST', `/orgs/${orgId}/purchases`, { locationId: stallId, supplierId: supplier.sabzi, payment: 'paid',
      moneyAccountId: acct.easypaisa, lines: [{ itemId: stock.Potato, qty: '1', unit: 'kg', totalMinor: rs(100) }] });
    expect(r.status).toBe(400);
  });

  it('rings sales item-first, including options and a custom amount', async () => {
    const a = await ok('shahzaib', 'POST', `/orgs/${orgId}/orders`, { locationId: stallId, clientRef: crypto.randomUUID(),
      lines: [{ variantId: variant['Salted Fries|Rs 100'], qty: 3 }, { variantId: variant['Masala Fries|Rs 200'], qty: 1, modifierIds: [modifier['Extra masala']] }] });
    expect(a.totalMinor).toBe(rs(300 + 220));
    orders.push(a.id);
    const ref = crypto.randomUUID();
    const b = await ok('shahzaib', 'POST', `/orgs/${orgId}/orders`, { locationId: stallId, clientRef: ref,
      lines: [{ variantId: variant['Salted Fries|Custom amount'], qty: 1, openPriceMinor: rs(70) }] });
    expect(b.totalMinor).toBe(rs(70));
    orders.push(b.id);
    // A retried request with the same till reference does not ring the sale twice.
    const again = await ok('shahzaib', 'POST', `/orgs/${orgId}/orders`, { locationId: stallId, clientRef: ref,
      lines: [{ variantId: variant['Salted Fries|Custom amount'], qty: 1, openPriceMinor: rs(70) }] });
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(b.id);
    const c = await ok('shahzaib', 'POST', `/orgs/${orgId}/orders`, { locationId: stallId, paymentAccountId: acct.easypaisa,
      lines: [{ variantId: variant['Salted Fries|Rs 200'], qty: 2 }] });
    orders.push(c.id);
    const d = await ok('shahzaib', 'POST', `/orgs/${orgId}/orders`, { locationId: stallId, lines: [{ variantId: variant['Salted Fries|Rs 50'], qty: 2 }] });
    orders.push(d.id);
    // Items not sold here are refused.
    const off = await call('shahzaib', 'POST', `/orgs/${orgId}/orders`, { locationId: stallId, lines: [{ variantId: variant['Salted Fries|Rs 300'] ?? crypto.randomUUID(), qty: 1 }] });
    expect(off.status).toBe(400);
  });

  it('voids need a reason and reverse the sale', async () => {
    expect((await call('shahzaib', 'POST', `/orgs/${orgId}/orders/${orders[3]}/void`, { reason: '' })).status).toBe(400);
    await ok('shahzaib', 'POST', `/orgs/${orgId}/orders/${orders[3]}/void`, { reason: 'Customer left before paying' });
    expect((await call('shahzaib', 'POST', `/orgs/${orgId}/orders/${orders[3]}/void`, { reason: 'again' })).status).toBe(409);
  });

  it('a salesperson without void rights is refused, until the right is granted to them personally', async () => {
    const person = await ok('taha', 'POST', `/orgs/${orgId}/people`, { fullName: 'Sam', displayName: 'Sam' });
    const u = await ok('taha', 'POST', `/orgs/${orgId}/users`, { personId: person.id, username: 'sam' });
    const roles = await ok('taha', 'GET', `/orgs/${orgId}/roles`);
    const sales = roles.find((r: { key: string }) => r.key === 'salesperson');
    await ok('taha', 'POST', `/orgs/${orgId}/role-assignments`, { userId: u.id, roleId: sales.id, allOrgs: false, orgIds: [orgId], locationIds: [stallId] });
    await login('sam', u.temporaryPassword);
    await ok('sam', 'POST', '/auth/password', { current: u.temporaryPassword, next: 'sam-sells-fries' });
    const sale = await ok('sam', 'POST', `/orgs/${orgId}/orders`, { locationId: stallId, lines: [{ variantId: variant['Salted Fries|Rs 150'], qty: 1 }] });
    expect((await call('sam', 'POST', `/orgs/${orgId}/orders/${sale.id}/void`, { reason: 'mistake' })).status).toBe(403);
    await ok('taha', 'POST', `/orgs/${orgId}/permission-overrides`, { userId: u.id, permission: 'pos.void', effect: 'grant', scopeOrgId: orgId });
    await login('sam', 'sam-sells-fries');
    await ok('sam', 'POST', `/orgs/${orgId}/orders/${sale.id}/void`, { reason: 'Rang wrong size' });
  });

  it('logs expenses; one above the limit blocks the close until decided', async () => {
    const heads = await ok('shahzaib', 'GET', `/orgs/${orgId}/ledger-heads`);
    const repairs = heads.find((h: { name: string }) => h.name.startsWith('Repairs')).id;
    const rent = heads.find((h: { name: string }) => h.name.startsWith('Rent')).id;
    const e1 = await ok('shahzaib', 'POST', `/orgs/${orgId}/expenses`, { locationId: stallId, categoryAccountId: repairs, amountMinor: rs(150),
      payment: 'paid', moneyAccountId: acct.drawer, description: 'Fryer basket handle' });
    expect(e1.status).toBe('posted');
    const e2 = await ok('shahzaib', 'POST', `/orgs/${orgId}/expenses`, { locationId: stallId, categoryAccountId: rent, amountMinor: rs(3000),
      payment: 'paid', moneyAccountId: acct.easypaisa, description: 'Stall spot fee for October' });
    expect(e2.status).toBe('pending_approval');
    await dispatchPending();
    const preview = await ok('shahzaib', 'GET', `/orgs/${orgId}/days/${dayId}/close-preview`);
    expect(preview.problems.join(' ')).toMatch(/waiting for approval/);
    // A question on the entry, answered in place.
    await ok('adil', 'POST', `/orgs/${orgId}/comments`, { entityType: 'approval', entityId: e2.approvalId, body: 'Is this the full month?', askUserId: (await ok('shahzaib', 'GET', '/auth/me')).user.userId });
    await ok('adil', 'POST', `/orgs/${orgId}/approvals/${e2.approvalId}/decide`, { decision: 'approve', note: 'OK for October' });
  });

  it('every sale reached the books and the stock', async () => {
    await dispatchPending();
    const pending = await withSystem((tx) => tx`select count(*)::int as n from orders.outbox where processed_at is null`);
    expect(pending[0]!.n).toBe(0);
    const lvl = await ok('shahzaib', 'GET', `/orgs/${orgId}/stock?locationId=${stallId}`);
    const santos = lvl.find((l: { name: string }) => l.name === 'Potato — Santos');
    // Used: 3 x Rs100 (220 g) + Rs200 masala (440 g) + Rs70 custom (154 g) + 2 x Rs200 (880 g) = 2,134 g.
    // The voided Rs 50 plates and Sam's voided Rs 150 plate were returned.
    expect(santos.qty_base).toBe('17866.000');
    // 20 kg cost Rs 2,000 (Rs 0.10/g): value left = 17,866 g x 10 paisa.
    expect(santos.value_minor).toBe(178660);
  });

  it('closes the day: counts, deposits to bank, flags a shortage', async () => {
    const preview = await ok('shahzaib', 'GET', `/orgs/${orgId}/days/${dayId}/close-preview`);
    expect(preview.problems).toEqual([]);
    // Cash sales: 520 + 70 = 590. Drawer = 1,000 float + 590 - 150 repairs = 1,440.
    expect(preview.figures.sales).toBe(rs(520 + 70 + 400));
    const drawer = preview.expected.find((e: { moneyAccountId: string }) => e.moneyAccountId === acct.drawer);
    expect(drawer.expectedMinor).toBe(rs(1440));
    const r = await ok('shahzaib', 'POST', `/orgs/${orgId}/days/${dayId}/close`, {
      transfers: [{ fromAccountId: acct.drawer, toAccountId: acct.bank, amountMinor: rs(400), note: 'Deposited' }],
      declared: [{ moneyAccountId: acct.drawer, declaredMinor: rs(1440 - 400 - 20) }],
      note: 'Rs 20 short' });
    expect(r.differenceMinor).toBe(-rs(20));
    // The till is closed for the day.
    expect((await call('shahzaib', 'POST', `/orgs/${orgId}/orders`, { locationId: stallId, lines: [{ variantId: variant['Salted Fries|Rs 100'], qty: 1 }] })).status).toBe(409);
  });

  it('a partner approves the close and the day locks', async () => {
    const pending = await ok('visam', 'GET', `/orgs/${orgId}/approvals?status=pending`);
    const close = pending.find((a: { kind: string }) => a.kind === 'day_close');
    expect(close.summary).toMatch(/short Rs 20/);
    await ok('visam', 'POST', `/orgs/${orgId}/approvals/${close.id}/decide`, { decision: 'approve' });
    const day = await ok('taha', 'GET', `/orgs/${orgId}/days/${dayId}`);
    expect(day.day.status).toBe('approved');
    expect(day.figures.sales).toBe(rs(990));
    // The shortage is booked, so the drawer in the books matches the count.
    const accts = await ok('taha', 'GET', `/orgs/${orgId}/money-accounts`);
    expect(accts.find((a: { id: string }) => a.id === acct.drawer).balance_minor).toBe(rs(1020));
    expect(accts.find((a: { id: string }) => a.id === acct.bank).balance_minor).toBe(rs(400));
    // Nothing can be posted to a locked day, and its sales can no longer be voided.
    expect((await call('shahzaib', 'POST', `/orgs/${orgId}/orders/${orders[0]}/void`, { reason: 'late' })).status).toBe(409);
    const tenant = (await withSystem((tx) => tx`select id from core.tenants where slug = 'opplox'`))[0]!.id;
    const locked = await withTenant(tenant, (tx) =>
      tx`insert into finance.journal_entries (tenant_id, org_id, business_day_id, entry_date, memo, source_type)
         select tenant_id, org_id, id, business_date, 'sneaky', 'test' from finance.business_days where id = ${dayId}`).then(() => 'inserted', (e: Error) => e.message);
    expect(locked).toMatch(/day_locked/);
    // Partners got the nightly summary.
    const n = await ok('adil', 'GET', '/notifications');
    expect(n.items.some((x: { type: string }) => x.type === 'daily_summary')).toBe(true);
  });

  it('the books balance and every report agrees', async () => {
    const today = (await ok('taha', 'GET', `/orgs/${orgId}/days/${dayId}`)).day.business_date;
    const tb = await ok('taha', 'GET', `/orgs/${orgId}/reports/trial-balance?asOf=${today}`);
    const d = tb.reduce((a: number, r: { debit_minor: number }) => a + r.debit_minor, 0);
    const c = tb.reduce((a: number, r: { credit_minor: number }) => a + r.credit_minor, 0);
    expect(d).toBe(c);
    const dash = await ok('taha', 'GET', `/orgs/${orgId}/reports/dashboard?from=${today}&to=${today}`);
    expect(dash.sales).toBe(rs(990));
    expect(dash.cogs).toBeGreaterThan(0);
    expect(dash.profit).toBe(dash.revenue - dash.expenses);
    const pnl = await ok('taha', 'GET', `/orgs/${orgId}/reports/pnl?from=${today}&to=${today}`);
    expect(pnl.reduce((a: number, r: { amount_minor: number }) => a + r.amount_minor, 0)).toBe(dash.profit);
    const plates = await ok('taha', 'GET', `/orgs/${orgId}/reports/plates?from=${today}&to=${today}`);
    const r100 = plates.find((p: { variant_name: string; item_name: string }) => p.item_name === 'Salted Fries' && p.variant_name === 'Rs 100');
    expect(r100.qty).toBe(3);
    expect(r100.revenue_minor).toBe(rs(300));
    expect(r100.cost_minor).toBeGreaterThan(0);
    const voids = await ok('taha', 'GET', `/orgs/${orgId}/reports/voids?from=${today}&to=${today}`);
    expect(voids.length).toBe(2);
    // Partner statement: three equal shares that add back to the profit exactly.
    const st = await ok('taha', 'GET', `/orgs/${orgId}/partners/statement?from=${today}&to=${today}`);
    const partners = st.filter((p: { role: string }) => p.role === 'partner');
    expect(partners).toHaveLength(3);
    expect(partners.reduce((a: number, p: { earnedMinor: number }) => a + p.earnedMinor, 0)).toBe(dash.profit);
    expect(st.find((p: { name: string }) => p.name === 'Taha')?.earnedMinor ?? 0).toBe(0);
  });
});

describe('capital, loans and payouts', () => {
  it('a payout needs approval and every partner is told', async () => {
    const w = await ok('visam', 'POST', `/orgs/${orgId}/capital/withdrawals`, { personId: people.visam, amountMinor: rs(100), moneyAccountId: acct.bank,
      reason: 'Monthly fixed payout' });
    await ok('adil', 'POST', `/orgs/${orgId}/approvals/${w.approvalId}/decide`, { decision: 'approve' });
    const n = await ok('shahzaib', 'GET', '/notifications');
    expect(n.items.some((x: { type: string }) => x.type === 'payout_made')).toBe(true);
  });

  it('a loan converts partly to investment; the refund closes only when the lender confirms', async () => {
    const loan = await ok('taha', 'POST', `/orgs/${orgId}/capital/loans`, { personId: people.taha, amountMinor: rs(10000), moneyAccountId: acct.bank,
      locationId: stallId, dueDate: '2026-12-31' });
    await ok('taha', 'POST', `/orgs/${orgId}/capital/loans/${loan.id}/convert`, { amountMinor: rs(4000), reason: 'Spent on a second fryer' });
    expect((await call('taha', 'POST', `/orgs/${orgId}/capital/loans/${loan.id}/convert`, { amountMinor: rs(7000), reason: 'too much' })).status).toBe(409);
    const refund = await ok('taha', 'POST', `/orgs/${orgId}/capital/loans/${loan.id}/refund`, { amountMinor: rs(6000), moneyAccountId: acct.bank });
    await ok('visam', 'POST', `/orgs/${orgId}/approvals/${refund.approvalId}/decide`, { decision: 'approve' });
    let cap = await ok('taha', 'GET', `/orgs/${orgId}/capital`);
    expect(cap.loans[0].status).toBe('open');
    expect(cap.txns.find((t: { id: string }) => t.id === refund.id).status).toBe('awaiting_confirmation');
    // Only the lender can confirm receipt.
    expect((await call('shahzaib', 'POST', `/orgs/${orgId}/capital/refunds/${refund.id}/confirm`)).status).toBe(403);
    await ok('taha', 'POST', `/orgs/${orgId}/capital/refunds/${refund.id}/confirm`);
    cap = await ok('taha', 'GET', `/orgs/${orgId}/capital`);
    expect(cap.loans[0].status).toBe('closed');
    const invested = cap.positions.filter((p: { person_name: string; key: string }) => p.person_name === 'Taha' && p.key === 'capital')
      .reduce((a: number, p: { balance_minor: number }) => a + p.balance_minor, 0);
    expect(invested).toBe(rs(1000 + 4000)); // opening float + converted loan
  });

  it('share changes are proposed, checked to add to 100%, and approved', async () => {
    const bad = await call('shahzaib', 'POST', `/orgs/${orgId}/partners/proposals`, { mode: 'percent', effectiveFrom: '2026-11-01',
      shares: [{ personId: people.shahzaib, weight: 50 }, { personId: people.visam, weight: 30 }, { personId: people.adil, weight: 30 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('shares_not_100');
    const okp = await ok('shahzaib', 'POST', `/orgs/${orgId}/partners/proposals`, { mode: 'percent', effectiveFrom: '2026-11-01',
      shares: [{ personId: people.shahzaib, weight: 33.33 }, { personId: people.visam, weight: 33.33 }, { personId: people.adil, weight: 33.33 }] });
    await ok('adil', 'POST', `/orgs/${orgId}/approvals/${okp.approvalId}/decide`, { decision: 'reject', note: 'No change needed' });
  });
});

describe('weekly stock count', () => {
  it('keeps the expected figure and books the difference', async () => {
    const r = await ok('shahzaib', 'POST', `/orgs/${orgId}/stock-counts`, { locationId: stallId,
      lines: [{ itemId: stock['Potato — Santos'], counted: '17.5', unit: 'kg' }] });
    expect(r.lines[0].expected).toBe('17866.000');
    expect(r.lines[0].counted).toBe('17500.000');
    expect(r.lines[0].diff).toBe('-366.000');
    expect(r.varianceMinor).toBe(-3660);
  });
});

describe('integrity', () => {
  it('posted ledger lines cannot be changed', async () => {
    const tenant = (await withSystem((tx) => tx`select id from core.tenants where slug = 'opplox'`))[0]!.id;
    const err = await withTenant(tenant, (tx) => tx`update finance.journal_lines set debit_minor = debit_minor + 1 where id = (select min(id) from finance.journal_lines)`)
      .then(() => 'updated', (e: Error) => e.message);
    expect(err).toMatch(/immutable_record/);
  });

  it('the audit trail chain verifies', async () => {
    const v = await withSystem((tx) => verifyAuditChain(tx));
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(20);
  });

  it('another tenant sees none of OPPLOX data', async () => {
    const other = (await withSystem((tx) => tx`insert into core.tenants (slug, name) values ('acme', 'ACME') returning id`))[0]!.id;
    const seen = await withTenant(other, async (tx) => ({
      orgs: (await tx`select count(*)::int as n from core.organizations`)[0]!.n,
      entries: (await tx`select count(*)::int as n from finance.journal_entries`)[0]!.n,
      orders: (await tx`select count(*)::int as n from orders.orders`)[0]!.n,
    }));
    expect(seen).toEqual({ orgs: 0, entries: 0, orders: 0 });
    const opplox = (await withSystem((tx) => tx`select id from core.tenants where slug = 'opplox'`))[0]!.id;
    const own = await withTenant(opplox, (tx) => tx`select count(*)::int as n from orders.orders`);
    expect(own[0]!.n).toBeGreaterThan(0);
  });
});
