import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../core/audit.js';
import { fromMilli, toMilli } from '../core/math.js';
import type { Tx } from '../db/db.js';
import { closeDb, withSystem } from '../db/db.js';
import { createMoneyAccountRaw } from '../modules/finance/index.js';
import { generateTempPassword, hashPassword } from '../modules/identity/index.js';
import { createLocationRaw, createOrgRaw, localDate } from '../modules/tenancy/index.js';
import { wire } from '../wiring.js';
import { MENU, MODIFIER_GROUPS, type SeedItem } from './menu-data.js';

// First-run seed: the OPPLOX tenant, the K-BAY organization with its first stall, the people and
// roles, money accounts, suppliers, stock items, the full pre-seeded menu and the fries recipes.
// Safe to run again: it does nothing if the tenant already exists.

export const ROLES: { key: string; name: string; description: string; permissions: string[] }[] = [
  { key: 'super_admin', name: 'Super admin', description: 'Full access across this customer\'s organizations.', permissions: ['*'] },
  { key: 'investor', name: 'Investor', description: 'Sees everything about the businesses they back.',
    permissions: ['investor.portal', 'reports.view', 'reports.partners', 'finance.view', 'inventory.view', 'comment.create', 'audit.view'] },
  { key: 'mentor', name: 'Mentor', description: 'Cost planning, reporting, tracking and forecasting.',
    permissions: ['reports.view', 'finance.view', 'inventory.view', 'comment.create'] },
  { key: 'management_partner', name: 'Management partner', description: 'Runs and grows operations; can delegate to employees.',
    permissions: ['pos.sell', 'pos.void', 'pos.refund', 'day.open', 'day.close', 'expense.create', 'purchase.create', 'supplier.manage', 'supplier.pay',
      'inventory.view', 'inventory.manage', 'inventory.count', 'inventory.waste', 'inventory.request', 'menu.manage', 'finance.view', 'accounts.manage',
      'capital.withdraw', 'payroll.manage', 'reports.view', 'reports.partners', 'approve.expense', 'approve.purchase', 'approve.supplier_credit',
      'approve.day_close', 'approve.refund', 'comment.create', 'users.manage', 'partners.manage', 'audit.view'] },
  { key: 'partner', name: 'Partner', description: 'Approves spends and closings, watches the reports.',
    permissions: ['reports.view', 'reports.partners', 'finance.view', 'inventory.view', 'capital.withdraw', 'partners.manage', 'comment.create', 'audit.view',
      'approve.expense', 'approve.purchase', 'approve.supplier_credit', 'approve.day_close', 'approve.withdrawal', 'approve.refund',
      'approve.loan_refund', 'approve.partner_change'] },
  { key: 'stall_lead', name: 'Stall lead', description: 'Opens, sells, logs spends and closes the day.',
    permissions: ['pos.sell', 'pos.void', 'pos.refund', 'day.open', 'day.close', 'expense.create', 'purchase.create', 'inventory.view', 'inventory.count',
      'inventory.waste', 'inventory.request', 'comment.create'] },
  { key: 'salesperson', name: 'Salesperson', description: 'Rings up sales. Void/refund rights can be added per person.',
    permissions: ['pos.sell', 'inventory.request', 'comment.create'] },
  { key: 'helper', name: 'Helper', description: 'Kitchen helper.', permissions: ['inventory.view', 'inventory.request', 'comment.create'] },
  { key: 'master_chef', name: 'Master chef', description: 'Taste, consistency, waste and recipe adherence across kitchens.',
    permissions: ['reports.view', 'inventory.view', 'inventory.manage', 'comment.create'] },
];

interface StockSeed { key: string; name: string; category: string; kind?: 'stock' | 'mix' | 'family'; dimension: 'mass' | 'volume' | 'count';
  unit: string; tracking?: 'precise' | 'bulk'; costClass?: 'food' | 'beverage' | 'packaging' | 'fuel'; low?: string; parent?: string }

const STOCK: StockSeed[] = [
  { key: 'potato', name: 'Potato', category: 'potatoes', kind: 'family', dimension: 'mass', unit: 'kg' },
  { key: 'santos', name: 'Potato — Santos', category: 'potatoes', dimension: 'mass', unit: 'kg', parent: 'potato', low: '5' },
  { key: 'santa', name: 'Potato — Santa', category: 'potatoes', dimension: 'mass', unit: 'kg', parent: 'potato', low: '5' },
  { key: 'pepsi_potato', name: 'Potato — Pepsi', category: 'potatoes', dimension: 'mass', unit: 'kg', parent: 'potato', low: '5' },
  { key: 'metro', name: 'Potato — Metro', category: 'potatoes', dimension: 'mass', unit: 'kg', parent: 'potato', low: '5' },
  { key: 'oil', name: 'Cooking oil', category: 'oil', dimension: 'volume', unit: 'l', tracking: 'bulk', low: '5' },
  { key: 'gas', name: 'Gas (LPG)', category: 'gas', dimension: 'mass', unit: 'kg', tracking: 'bulk', costClass: 'fuel', low: '3' },
  { key: 'corn_flour', name: 'Corn flour', category: 'coating & spices', dimension: 'mass', unit: 'kg', tracking: 'bulk', low: '1' },
  { key: 'chilli', name: 'Red chilli powder', category: 'coating & spices', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'salt', name: 'Salt', category: 'coating & spices', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'garlic_powder', name: 'Garlic powder', category: 'coating & spices', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'pepper', name: 'Black pepper', category: 'coating & spices', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'coating', name: 'Fries coating mix', category: 'coating & spices', kind: 'mix', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'masala', name: 'K-BAY fries masala', category: 'coating & spices', dimension: 'mass', unit: 'kg', tracking: 'bulk', low: '0.5' },
  { key: 'cheese_sauce', name: 'Cheese sauce', category: 'sauces & toppings', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'mozzarella', name: 'Mozzarella cheese', category: 'sauces & toppings', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'pizza_sauce', name: 'Pizza sauce', category: 'sauces & toppings', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'mayo', name: 'Mayonnaise', category: 'sauces & toppings', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'garlic_mayo', name: 'Garlic mayo', category: 'sauces & toppings', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'chilli_garlic', name: 'Chilli garlic sauce', category: 'sauces & toppings', dimension: 'mass', unit: 'kg', tracking: 'bulk' },
  { key: 'ketchup', name: 'Ketchup sachet', category: 'sauces & toppings', dimension: 'count', unit: 'unit', low: '50' },
  { key: 'chicken', name: 'Chicken (boneless)', category: 'meat', dimension: 'mass', unit: 'kg' },
  { key: 'box', name: 'Fries box', category: 'packaging', dimension: 'count', unit: 'unit', costClass: 'packaging', low: '50' },
  { key: 'bag', name: 'Paper bag', category: 'packaging', dimension: 'count', unit: 'unit', costClass: 'packaging' },
  { key: 'fork', name: 'Wooden fork', category: 'packaging', dimension: 'count', unit: 'unit', costClass: 'packaging' },
  { key: 'can', name: 'Soft drink can', category: 'beverages', dimension: 'count', unit: 'unit', costClass: 'beverage' },
  { key: 'sd250', name: 'Soft drink 250ml', category: 'beverages', dimension: 'count', unit: 'unit', costClass: 'beverage' },
  { key: 'sd350', name: 'Soft drink 350ml', category: 'beverages', dimension: 'count', unit: 'unit', costClass: 'beverage' },
  { key: 'sd500', name: 'Soft drink 500ml', category: 'beverages', dimension: 'count', unit: 'unit', costClass: 'beverage' },
  { key: 'sd1500', name: 'Soft drink 1.5L', category: 'beverages', dimension: 'count', unit: 'unit', costClass: 'beverage' },
];

/** Coating sub-mix, per 1 kg of mix (grams). */
const COATING_MIX: [string, string][] = [['corn_flour', '700'], ['chilli', '100'], ['salt', '100'], ['garlic_powder', '50'], ['pepper', '50']];

type Line = [stockKey: string, qtyBase: string, stage: 'prep' | 'fry' | 'serve'];

/**
 * Estimated recipe per fries plate, scaled by the plate's rupee size. To be replaced by the
 * one-time calibration study (measure potato, oil and spice per plate size).
 */
function friesLines(rupees: number, extra: Line[] = []): Line[] {
  const g = (perRupee: number) => fromMilli(Math.round(rupees * perRupee * 1000));
  return [
    ['potato', g(2.2), 'fry'], // ~220 g raw potato for a Rs 100 plate
    ['coating', g(0.044), 'prep'], // coating ~2% of potato
    ['oil', g(0.08), 'fry'], // ~8 ml oil absorbed/used per Rs 100
    ['gas', g(0.06), 'fry'], // ~6 g LPG per Rs 100
    ['box', '1.000', 'serve'],
    ['ketchup', '1.000', 'serve'],
    ...extra,
  ];
}

/** Grams as a numeric(18,3) string, rounded to the milligram. */
const q = (grams: number) => fromMilli(Math.round(grams * 1000));

const SML_RUPEES: Record<string, number> = { Small: 150, Medium: 200, Large: 250 };

function recipeFor(item: SeedItem, variantName: string, price: number): Line[] {
  switch (item.recipe) {
    case 'plain_fries': return friesLines(price);
    case 'masala_fries': return friesLines(price, [['masala', fromMilli(Math.round(price * 0.03 * 1000)), 'serve']]);
    case 'cheesy_fries': { const r = SML_RUPEES[variantName] ?? 200; return friesLines(r, [['cheese_sauce', q(r * 0.25), 'serve']]); }
    case 'garlic_mayo_fries': { const r = SML_RUPEES[variantName] ?? 200; return friesLines(r, [['garlic_mayo', q(r * 0.15), 'serve']]); }
    case 'pizza_fries': { const r = SML_RUPEES[variantName] ?? 200; return friesLines(r, [['pizza_sauce', q(r * 0.15), 'serve'], ['mozzarella', q(r * 0.25), 'serve'], ['chicken', q(r * 0.2), 'serve']]); }
    case 'loaded_fries': { const r = SML_RUPEES[variantName] ?? 200; return friesLines(r, [['cheese_sauce', q(r * 0.2), 'serve'], ['chicken', q(r * 0.35), 'serve'], ['mayo', q(r * 0.1), 'serve']]); }
    case 'bottle': {
      const map: Record<string, string> = { Can: 'can', '250ml': 'sd250', '350ml': 'sd350', '500ml': 'sd500', '1.5 litre': 'sd1500' };
      return map[variantName] ? [[map[variantName]!, '1.000', 'serve']] : [];
    }
    default: return [];
  }
}

const MODIFIER_RECIPES: Record<string, Line[]> = {
  Ketchup: [['ketchup', '1.000', 'serve']],
  Mayo: [['mayo', '15.000', 'serve']],
  'Chilli garlic': [['chilli_garlic', '15.000', 'serve']],
  'Extra masala': [['masala', '3.000', 'serve']],
  'Extra mayo': [['mayo', '20.000', 'serve']],
  'Cheese sauce': [['cheese_sauce', '40.000', 'serve']],
  'Extra ketchup sachet': [['ketchup', '1.000', 'serve']],
};

const UNIT_FACTOR: Record<string, number> = { kg: 1000, l: 1000, unit: 1 };

export interface SeedResult { created: boolean; credentials: { username: string; name: string; password: string; roles: string }[] }

export async function seed(log = console.log): Promise<SeedResult> {
  wire();
  return withSystem(async (tx) => {
    const [existing] = await tx`select id from core.tenants where slug = 'opplox'`;
    if (existing) {
      log('Tenant OPPLOX already exists — nothing to do.');
      return { created: false, credentials: [] };
    }
    const [t] = await tx<{ id: string }[]>`insert into core.tenants (slug, name) values ('opplox', 'OPPLOX') returning id`;
    const tenantId = t!.id;
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;

    const orgId = await createOrgRaw(tx, tenantId, { name: 'K-Bay', slug: 'kbay', brandName: 'K-BAY' });
    await tx`update core.organizations set settings = ${tx.json({ approvalLimitMinor: 200000, defaultCustomerDiscountBps: 0, loyaltyEnabled: false } as never)}
      where id = ${orgId}`;
    const stallId = await createLocationRaw(tx, tenantId, orgId, { name: 'K-Bay Stall 1', kind: 'stall', city: 'Islamabad', approvalLimitMinor: 200000 });
    const today = localDate('Asia/Karachi');

    // Roles
    const roleIds: Record<string, string> = {};
    for (const r of ROLES) {
      const [row] = await tx<{ id: string }[]>`insert into core.roles (tenant_id, key, name, description, permissions, is_system)
        values (${tenantId}, ${r.key}, ${r.name}, ${r.description}, ${r.permissions}, true) returning id`;
      roleIds[r.key] = row!.id;
    }

    // People and their logins (temporary passwords, changed on first sign-in)
    const people = [
      { key: 'taha', fullName: 'Taha', display: 'Taha', owner: true,
        roles: [{ role: 'super_admin', allOrgs: true }, { role: 'investor', allOrgs: true }, { role: 'mentor', allOrgs: true }] },
      { key: 'shahzaib', fullName: 'Shahzaib', display: 'KB (Shazi)', owner: false,
        roles: [{ role: 'management_partner', allOrgs: false }, { role: 'stall_lead', allOrgs: false }] },
      { key: 'visam', fullName: 'Visam', display: 'Visam', owner: false, roles: [{ role: 'partner', allOrgs: false }] },
      { key: 'adil', fullName: 'Adil', display: 'Adil', owner: false, roles: [{ role: 'partner', allOrgs: false }] },
    ];
    const personIds: Record<string, string> = {};
    const credentials: SeedResult['credentials'] = [];
    for (const p of people) {
      const [row] = await tx<{ id: string }[]>`insert into core.people (tenant_id, full_name, display_name) values (${tenantId}, ${p.fullName}, ${p.display}) returning id`;
      personIds[p.key] = row!.id;
      await tx`insert into core.person_orgs (tenant_id, person_id, org_id) values (${tenantId}, ${row!.id}, ${orgId})`;
      const password = generateTempPassword();
      const [u] = await tx<{ id: string }[]>`insert into core.users (tenant_id, person_id, username, password_hash, must_change_password, is_platform_owner)
        values (${tenantId}, ${row!.id}, ${p.key}, ${await hashPassword(password)}, true, ${p.owner}) returning id`;
      for (const r of p.roles) {
        await tx`insert into core.role_assignments (tenant_id, user_id, role_id, all_orgs, org_ids)
          values (${tenantId}, ${u!.id}, ${roleIds[r.role]!}, ${r.allOrgs}, ${r.allOrgs ? [] : [orgId]})`;
      }
      credentials.push({ username: p.key, name: p.display, password, roles: p.roles.map((r) => r.role).join(', ') });
    }

    // Partners: Visam, Adil and Shahzaib share profit equally (1:1:1 = 33.33% each).
    // Taha is the investor: no profit share in K-Bay, mentorship on.
    for (const k of ['shahzaib', 'visam', 'adil']) {
      await tx`insert into finance.partner_shares (tenant_id, org_id, person_id, weight, effective_from) values (${tenantId}, ${orgId}, ${personIds[k]!}, 1, ${today})`;
    }
    await tx`insert into finance.investor_terms (tenant_id, org_id, person_id, takes_return, return_weight, mentorship, effective_from)
      values (${tenantId}, ${orgId}, ${personIds.taha!}, false, 0, true, ${today})`;

    // Money accounts (the stall's cash drawer is created with the stall).
    await createMoneyAccountRaw(tx, tenantId, orgId, { name: "Shazi's easypaisa", kind: 'easypaisa', ownerPersonId: personIds.shahzaib });
    await createMoneyAccountRaw(tx, tenantId, orgId, { name: "Taha's bank account", kind: 'bank', ownerPersonId: personIds.taha });

    for (const s of ['Sabzi mandi (potatoes)', 'Cash & carry (oil, spices, packaging)', 'Gas cylinder shop', 'Soft drinks distributor']) {
      await tx`insert into finance.suppliers (tenant_id, org_id, name) values (${tenantId}, ${orgId}, ${s})`;
    }

    // Taxes and fees: present but off until needed (rates change; all editable).
    await tx`insert into catalog.tax_rates (tenant_id, org_id, name, rate_bps, applies_to, inclusive, enabled) values
      (${tenantId}, ${orgId}, 'GST', 1650, 'all', false, false),
      (${tenantId}, ${orgId}, 'Card / digital payment fee', 500, 'card', false, false)`;

    // Stock items
    const stockIds: Record<string, string> = {};
    for (const s of STOCK) {
      const low = s.low ? fromMilli(toMilli(s.low) * (UNIT_FACTOR[s.unit] ?? 1)) : null;
      const [row] = await tx<{ id: string }[]>`insert into inventory.items (tenant_id, org_id, parent_id, name, category, kind, dimension, purchase_unit,
          tracking, cost_class, low_stock_base)
        values (${tenantId}, ${orgId}, ${s.parent ? stockIds[s.parent]! : null}, ${s.name}, ${s.category}, ${s.kind ?? 'stock'}, ${s.dimension}, ${s.unit},
          ${s.tracking ?? 'precise'}, ${s.costClass ?? 'food'}, ${low}) returning id`;
      stockIds[s.key] = row!.id;
    }
    for (const [k, grams] of COATING_MIX) {
      await tx`insert into inventory.mix_components (tenant_id, mix_id, component_item_id, per_1000_base)
        values (${tenantId}, ${stockIds.coating!}, ${stockIds[k]!}, ${grams})`;
    }
    await tx`insert into inventory.location_varieties (tenant_id, location_id, family_item_id, variety_item_id)
      values (${tenantId}, ${stallId}, ${stockIds.potato!}, ${stockIds.santos!})`;

    // Menu
    const variantIds: Record<string, string> = {};
    const itemIds: Record<string, string> = {};
    const groupIds: Record<string, string> = {};
    const modifierIds: Record<string, string> = {};
    for (const g of MODIFIER_GROUPS) {
      const [row] = await tx<{ id: string }[]>`insert into catalog.modifier_groups (tenant_id, org_id, name, min_select, max_select)
        values (${tenantId}, ${orgId}, ${g.name}, ${g.min}, ${g.max}) returning id`;
      groupIds[g.name] = row!.id;
      for (const [i, m] of g.modifiers.entries()) {
        const [mr] = await tx<{ id: string }[]>`insert into catalog.modifiers (tenant_id, group_id, name, price_delta_minor, sort)
          values (${tenantId}, ${row!.id}, ${m.name}, ${m.price * 100}, ${i}) returning id`;
        modifierIds[m.name] = mr!.id;
        for (const [key, qty] of MODIFIER_RECIPES[m.name] ?? []) {
          await tx`insert into inventory.modifier_recipe_lines (tenant_id, modifier_id, item_id, qty_base) values (${tenantId}, ${mr!.id}, ${stockIds[key]!}, ${qty})`;
        }
      }
    }
    for (const [ci, cat] of MENU.entries()) {
      const [c] = await tx<{ id: string }[]>`insert into catalog.menu_categories (tenant_id, org_id, name, kind, sort)
        values (${tenantId}, ${orgId}, ${cat.name}, ${cat.kind}, ${ci}) returning id`;
      for (const [ii, item] of cat.items.entries()) {
        const [it] = await tx<{ id: string }[]>`insert into catalog.menu_items (tenant_id, org_id, category_id, name, description, image, enabled, is_deal, sort)
          values (${tenantId}, ${orgId}, ${c!.id}, ${item.name}, ${item.description ?? null}, ${item.image}, ${item.enabled ?? false},
            ${Boolean(item.deal)}, ${ii}) returning id`;
        itemIds[item.name] = it!.id;
        for (const [vi, v] of item.variants.entries()) {
          const [vr] = await tx<{ id: string }[]>`insert into catalog.menu_variants (tenant_id, org_id, menu_item_id, name, size_tag, price_minor,
              open_price, recipe_basis_minor, enabled, sort)
            values (${tenantId}, ${orgId}, ${it!.id}, ${v.name}, ${v.tag ?? null}, ${v.price * 100}, ${Boolean(v.openPrice)},
              ${v.openPrice ? v.openPrice.basis * 100 : null}, ${v.enabled ?? true}, ${vi}) returning id`;
          variantIds[`${item.name}|${v.name}`] = vr!.id;
          const recipePrice = v.openPrice ? v.openPrice.basis : v.price;
          for (const [key, qty, stage] of recipeFor(item, v.name, recipePrice)) {
            await tx`insert into inventory.recipe_lines (tenant_id, variant_id, item_id, qty_base, stage)
              values (${tenantId}, ${vr!.id}, ${stockIds[key]!}, ${qty}, ${stage})`;
          }
        }
        for (const g of item.modifiers ?? []) {
          await tx`insert into catalog.item_modifier_groups (tenant_id, menu_item_id, group_id) values (${tenantId}, ${it!.id}, ${groupIds[g]!})`;
        }
      }
    }
    for (const cat of MENU) {
      for (const item of cat.items) {
        for (const d of item.deal ?? []) {
          for (const comp of d.components) {
            await tx`insert into catalog.deal_components (tenant_id, deal_variant_id, component_variant_id, qty)
              values (${tenantId}, ${variantIds[`${item.name}|${d.variant}`]!}, ${variantIds[`${comp.item}|${comp.variant}`]!}, ${comp.qty})`;
          }
        }
      }
    }
    await audit(tx as Tx, { tenantId, orgId, action: 'seed.completed', entityType: 'tenant', entityId: tenantId,
      after: { org: 'K-Bay', stall: 'K-Bay Stall 1', users: credentials.map((c) => c.username) } });
    log('Seeded OPPLOX / K-BAY.');
    return { created: true, credentials };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed()
    .then(async (r) => {
      if (r.created) {
        console.log('\nTemporary passwords (shown once — each person must set their own at first sign-in):');
        console.table(r.credentials);
      }
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await closeDb();
      process.exit(1);
    });
}
