import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, notFound } from '../../core/errors.js';
import { mulDiv, toMilli } from '../../core/math.js';
import { type Dimension, fromBaseMilli, isUnit, toBaseMilli, type UnitCode } from '../../core/units.js';
import type { OrderCompleted, OrderVoided } from '../../contracts/order-events.js';
import type { Tx } from '../../db/db.js';
import { variantInfo } from '../catalog/index.js';
import { accountId, findEntry, postEntry, reverseEntry, type SystemKey } from '../ledger/index.js';
import { assertLocationInOrg, getOrg, localDate } from '../tenancy/index.js';
import { applyMovement, averageCost, explodeUsage, milliStr, modifierUsage, variantUsage } from './stock.js';

const COGS_KEY: Record<string, SystemKey> = { food: 'cogs_food', beverage: 'cogs_beverage', packaging: 'cogs_packaging', fuel: 'cogs_fuel' };
const WASTE_KEY: Record<string, SystemKey> = { food: 'waste_food', beverage: 'waste_beverage', other: 'waste_other' };

async function itemRow(tx: Tx, orgId: string, itemId: string) {
  const [i] = await tx<{ id: string; name: string; kind: string; dimension: Dimension; purchase_unit: UnitCode; cost_class: string }[]>`
    select id, name, kind, dimension, purchase_unit, cost_class from inventory.items where id = ${itemId} and org_id = ${orgId}`;
  if (!i) throw notFound('Stock item');
  return i;
}

const costClassOf = async (tx: Tx, itemId: string) =>
  (await tx<{ cost_class: string }[]>`select cost_class from inventory.items where id = ${itemId}`)[0]!.cost_class;

/** Post value grouped by account: Dr each expense head, Cr inventory (or the reverse for negative totals). */
async function postInventoryCost(tx: Tx, args: { tenantId: string; orgId: string; locationId: string; businessDayId: string | null;
  entryDate: string; memo: string; sourceType: string; sourceId: string; createdBy?: string | null; byKey: Map<SystemKey, number> }) {
  const inv = await accountId(tx, args.orgId, 'inventory');
  const lines = [];
  let total = 0;
  for (const [key, v] of args.byKey) {
    if (v === 0) continue;
    const acct = await accountId(tx, args.orgId, key);
    lines.push(v > 0 ? { account: acct, debit: v } : { account: acct, credit: -v });
    total += v;
  }
  if (lines.length === 0) return null;
  if (total > 0) lines.push({ account: inv, credit: total });
  else if (total < 0) lines.push({ account: inv, debit: -total });
  if (lines.length < 2) return null;
  return postEntry(tx, { tenantId: args.tenantId, orgId: args.orgId, locationId: args.locationId, businessDayId: args.businessDayId,
    entryDate: args.entryDate, memo: args.memo, sourceType: args.sourceType, sourceId: args.sourceId, createdBy: args.createdBy, lines });
}

// ---- Order event consumers: a sale quietly draws its ingredients from stock ----

export async function onOrderCompleted(tx: Tx, e: OrderCompleted): Promise<void> {
  const byKey = new Map<SystemKey, number>();
  for (const line of e.lines) {
    const v = await variantInfo(tx, line.variantId);
    if (!v) continue;
    const perUnit = await variantUsage(tx, line.variantId);
    const usage = new Map<string, number>();
    // Custom-amount sizes scale their recipe by amount paid / amount the recipe was written for.
    const modDelta = line.modifiers.reduce((s, m) => s + m.priceDeltaMinor, 0);
    const base = line.unitPriceMinor - modDelta;
    for (const [item, q] of perUnit) {
      const scaled = v.open_price && v.recipe_basis_minor ? mulDiv(q, base, v.recipe_basis_minor) : q;
      usage.set(item, (usage.get(item) ?? 0) + scaled * line.qty);
    }
    for (const m of line.modifiers) {
      for (const [item, q] of await modifierUsage(tx, m.id)) usage.set(item, (usage.get(item) ?? 0) + q * line.qty);
    }
    for (const [itemId, qty] of await explodeUsage(tx, e.locationId, usage)) {
      const value = await applyMovement(tx, { tenantId: e.tenantId, orgId: e.orgId, locationId: e.locationId, itemId, qtyMilli: -qty,
        reason: 'sale', businessDayId: e.businessDayId, refType: 'order', refId: e.orderId, refLineId: line.lineId, createdBy: e.createdBy });
      const key = COGS_KEY[await costClassOf(tx, itemId)] ?? 'cogs_food';
      byKey.set(key, (byKey.get(key) ?? 0) - value);
    }
  }
  await postInventoryCost(tx, { tenantId: e.tenantId, orgId: e.orgId, locationId: e.locationId, businessDayId: e.businessDayId,
    entryDate: e.businessDate, memo: `Cost of sale #${e.orderNo}`, sourceType: 'order_cogs', sourceId: e.orderId, createdBy: e.createdBy, byKey });
}

export async function onOrderVoided(tx: Tx, e: OrderVoided): Promise<void> {
  const moves = await tx<{ item_id: string; qty_base: string; value_minor: number; ref_line_id: string | null }[]>`
    select item_id, qty_base, value_minor, ref_line_id from inventory.movements
    where ref_type = 'order' and ref_id = ${e.orderId} and reason = 'sale'`;
  for (const m of moves) {
    // Exact mirror of the original draw, so the void leaves stock and value as they were.
    await applyMovement(tx, { tenantId: e.tenantId, orgId: e.orgId, locationId: e.locationId, itemId: m.item_id, qtyMilli: -toMilli(m.qty_base),
      valueMinor: -m.value_minor, reason: 'void', businessDayId: e.businessDayId, refType: 'order', refId: e.orderId,
      refLineId: m.ref_line_id ?? undefined, createdBy: e.voidedBy });
  }
  const entryId = await findEntry(tx, 'order_cogs', e.orderId);
  if (entryId) {
    await reverseEntry(tx, entryId, { memo: 'Void: cost of sale returned', sourceType: 'order_cogs_void', sourceId: e.orderId,
      businessDayId: e.businessDayId, entryDate: e.businessDate, createdBy: e.voidedBy });
  }
}

/** Purchases add stock at their price (called by finance when a purchase posts). */
export async function receiveStock(tx: Tx, args: { tenantId: string; orgId: string; locationId: string; itemId: string; qtyMilli: number;
  valueMinor: number; businessDayId: string | null; purchaseId: string; lineId: string; createdBy: string }) {
  const [it] = await tx<{ kind: string; name: string }[]>`select kind, name from inventory.items where id = ${args.itemId}`;
  if (!it) throw notFound('Stock item');
  if (it.kind !== 'stock') throw badRequest('not_stock_item', `${it.name} is a group or mix; buy a specific variety or ingredient.`);
  await applyMovement(tx, { tenantId: args.tenantId, orgId: args.orgId, locationId: args.locationId, itemId: args.itemId, qtyMilli: args.qtyMilli,
    valueMinor: args.valueMinor, reason: 'purchase', businessDayId: args.businessDayId, refType: 'purchase', refId: args.purchaseId,
    refLineId: args.lineId, createdBy: args.createdBy });
}

// ---- Stock items, varieties, mixes and recipes ----

export async function listItems(ctx: Ctx, orgId: string) {
  requirePerm(ctx, 'inventory.view', orgId);
  return ctx.tx`
    select i.id, i.parent_id, i.name, i.category, i.kind, i.dimension, i.purchase_unit, i.tracking, i.cost_class, i.low_stock_base, i.active,
      coalesce((select json_agg(json_build_object('itemId', m.component_item_id, 'per1000Base', m.per_1000_base))
        from inventory.mix_components m where m.mix_id = i.id), '[]') as components
    from inventory.items i where i.org_id = ${orgId} order by i.category, i.name`;
}

export async function upsertItem(ctx: Ctx, orgId: string, input: { id?: string; parentId?: string | null; name: string; category: string;
  kind: 'stock' | 'mix' | 'family'; dimension: Dimension; purchaseUnit: string; tracking: 'precise' | 'bulk';
  costClass: 'food' | 'beverage' | 'packaging' | 'fuel'; lowStock?: string | null; active?: boolean }) {
  requirePerm(ctx, 'inventory.manage', orgId);
  if (!isUnit(input.purchaseUnit)) throw badRequest('bad_unit', 'Unknown unit');
  const low = input.lowStock ? milliStr(toBaseMilli(input.lowStock, input.purchaseUnit, input.dimension)) : null;
  if (input.parentId) {
    const parent = await itemRow(ctx.tx, orgId, input.parentId);
    if (parent.kind !== 'family') throw badRequest('bad_parent', 'Varieties can only sit under a group item.');
    if (parent.dimension !== input.dimension) throw badRequest('unit_mismatch', 'A variety must be measured like its group.');
  }
  if (input.id) {
    const [before] = await ctx.tx`select * from inventory.items where id = ${input.id} and org_id = ${orgId}`;
    if (!before) throw notFound('Stock item');
    if (before.dimension !== input.dimension) {
      const [m] = await ctx.tx<{ n: number }[]>`select count(*)::int as n from inventory.movements where item_id = ${input.id}`;
      if (m!.n > 0) throw badRequest('dimension_locked', 'This item has stock history; its measurement type cannot change.');
    }
    await ctx.tx`update inventory.items set parent_id = ${input.parentId ?? null}, name = ${input.name}, category = ${input.category},
      kind = ${input.kind}, dimension = ${input.dimension}, purchase_unit = ${input.purchaseUnit}, tracking = ${input.tracking},
      cost_class = ${input.costClass}, low_stock_base = ${low}, active = ${input.active ?? true} where id = ${input.id}`;
    await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'stock_item.updated', entityType: 'stock_item', entityId: input.id, before, after: input });
    return { id: input.id };
  }
  const [r] = await ctx.tx<{ id: string }[]>`insert into inventory.items (tenant_id, org_id, parent_id, name, category, kind, dimension,
      purchase_unit, tracking, cost_class, low_stock_base)
    values (${ctx.tenantId}, ${orgId}, ${input.parentId ?? null}, ${input.name}, ${input.category}, ${input.kind}, ${input.dimension},
      ${input.purchaseUnit}, ${input.tracking}, ${input.costClass}, ${low}) returning id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'stock_item.created', entityType: 'stock_item', entityId: r!.id, after: input });
  return { id: r!.id };
}

/** Define a sub-mix once: component amounts per 1 kg / 1 L / 1 unit of the mix. */
export async function setMixComponents(ctx: Ctx, orgId: string, mixId: string, comps: { itemId: string; qty: string; unit: string }[]) {
  requirePerm(ctx, 'inventory.manage', orgId);
  const mix = await itemRow(ctx.tx, orgId, mixId);
  if (mix.kind !== 'mix') throw badRequest('not_mix', 'That item is not a mix.');
  await ctx.tx`delete from inventory.mix_components where mix_id = ${mixId}`;
  for (const c of comps) {
    const it = await itemRow(ctx.tx, orgId, c.itemId);
    const per1000 = toBaseMilli(c.qty, c.unit, it.dimension); // milli-base per 1 kg/L/unit of mix = per 1000 base units
    await ctx.tx`insert into inventory.mix_components (tenant_id, mix_id, component_item_id, per_1000_base)
      values (${ctx.tenantId}, ${mixId}, ${c.itemId}, ${milliStr(per1000)})`;
  }
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'mix.updated', entityType: 'stock_item', entityId: mixId, after: comps });
}

export async function setVariety(ctx: Ctx, orgId: string, locationId: string, familyId: string, varietyId: string) {
  requirePerm(ctx, 'inventory.manage', orgId, locationId);
  await assertLocationInOrg(ctx.tx, orgId, locationId);
  const v = await itemRow(ctx.tx, orgId, varietyId);
  const [parent] = await ctx.tx<{ parent_id: string | null }[]>`select parent_id from inventory.items where id = ${varietyId}`;
  if (parent?.parent_id !== familyId) throw badRequest('not_variety', `${v.name} is not a variety of that item.`);
  await ctx.tx`insert into inventory.location_varieties (tenant_id, location_id, family_item_id, variety_item_id)
    values (${ctx.tenantId}, ${locationId}, ${familyId}, ${varietyId})
    on conflict (location_id, family_item_id) do update set variety_item_id = excluded.variety_item_id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'variety.selected', entityType: 'location', entityId: locationId, after: { familyId, varietyId } });
}

export async function getRecipe(ctx: Ctx, orgId: string, variantId: string) {
  requirePerm(ctx, 'inventory.view', orgId);
  return ctx.tx`select r.id, r.item_id, i.name as item_name, r.qty_base, r.stage, i.dimension
    from inventory.recipe_lines r join inventory.items i on i.id = r.item_id
    join catalog.menu_variants v on v.id = r.variant_id
    where r.variant_id = ${variantId} and v.org_id = ${orgId} order by r.stage, i.name`;
}

export async function setRecipe(ctx: Ctx, orgId: string, variantId: string, lines: { itemId: string; qty: string; unit: string; stage: 'prep' | 'fry' | 'serve' }[]) {
  requirePerm(ctx, 'inventory.manage', orgId);
  const before = await getRecipe(ctx, orgId, variantId);
  await ctx.tx`delete from inventory.recipe_lines where variant_id = ${variantId}`;
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.itemId)) throw badRequest('duplicate_ingredient', 'Each ingredient appears once per recipe.');
    seen.add(l.itemId);
    const it = await itemRow(ctx.tx, orgId, l.itemId);
    const base = toBaseMilli(l.qty, l.unit, it.dimension);
    if (base <= 0) throw badRequest('bad_qty', 'Amounts must be above zero.');
    await ctx.tx`insert into inventory.recipe_lines (tenant_id, variant_id, item_id, qty_base, stage)
      values (${ctx.tenantId}, ${variantId}, ${l.itemId}, ${milliStr(base)}, ${l.stage})`;
  }
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'recipe.updated', entityType: 'menu_variant', entityId: variantId, before, after: lines });
}

/**
 * Theoretical cost of every size on the menu at a location (recipe x current average cost) and
 * the margin it leaves. Custom-amount sizes are costed at their recipe basis amount.
 */
export async function plateCosts(ctx: Ctx, orgId: string, locationId: string) {
  requirePerm(ctx, 'reports.view', orgId, locationId);
  const variants = await ctx.tx<{ id: string; item_name: string; variant_name: string; price_minor: number; open_price: boolean;
    recipe_basis_minor: number | null; enabled: boolean }[]>`
    select v.id, i.name as item_name, v.name as variant_name, v.price_minor, v.open_price, v.recipe_basis_minor, (v.enabled and i.enabled) as enabled
    from catalog.menu_variants v join catalog.menu_items i on i.id = v.menu_item_id
    where v.org_id = ${orgId} and i.enabled order by i.sort, i.name, v.sort, v.price_minor`;
  const out = [];
  for (const v of variants) {
    const usage = await variantUsage(ctx.tx, v.id);
    if (usage.size === 0) {
      out.push({ ...v, cost_minor: null, margin_minor: null, has_recipe: false });
      continue;
    }
    let cost = 0;
    for (const [itemId, q] of await explodeUsage(ctx.tx, locationId, usage)) cost += await averageCost(ctx.tx, locationId, itemId, q);
    const price = v.open_price ? (v.recipe_basis_minor ?? 0) : v.price_minor;
    out.push({ ...v, cost_minor: cost, margin_minor: price - cost, has_recipe: true });
  }
  return out;
}

// ---- Stock on hand, waste, requests and the weekly count ----

export async function stockLevels(ctx: Ctx, orgId: string, locationId: string) {
  requirePerm(ctx, 'inventory.view', orgId, locationId);
  const rows = await ctx.tx<{ id: string; name: string; category: string; parent_id: string | null; dimension: Dimension; purchase_unit: UnitCode;
    tracking: string; low_stock_base: string | null; qty_base: string | null; value_minor: number | null }[]>`
    select i.id, i.name, i.category, i.parent_id, i.dimension, i.purchase_unit, i.tracking, i.low_stock_base, s.qty_base, s.value_minor
    from inventory.items i left join inventory.stock_levels s on s.item_id = i.id and s.location_id = ${locationId}
    where i.org_id = ${orgId} and i.kind = 'stock' and i.active order by i.category, i.name`;
  return rows.map((r) => {
    const qty = r.qty_base ? toMilli(r.qty_base) : 0;
    const low = r.low_stock_base ? toMilli(r.low_stock_base) : null;
    return {
      ...r,
      qty_display: (fromBaseMilli(qty, r.purchase_unit) / 1000).toFixed(3),
      value_minor: r.value_minor ?? 0,
      is_low: low !== null && qty <= low,
    };
  });
}

export async function recordWaste(ctx: Ctx, orgId: string, input: { locationId: string; itemId: string; qty: string; unit: string;
  wasteClass: 'food' | 'beverage' | 'other'; reason: string; businessDayId: string | null }) {
  requirePerm(ctx, 'inventory.waste', orgId, input.locationId);
  await assertLocationInOrg(ctx.tx, orgId, input.locationId);
  if (!input.reason.trim()) throw badRequest('reason_required', 'Say what happened (spoiled, dropped, broken...).');
  const it = await itemRow(ctx.tx, orgId, input.itemId);
  const qty = toBaseMilli(input.qty, input.unit, it.dimension);
  if (qty <= 0) throw badRequest('bad_qty', 'Amount must be above zero.');
  const org = await getOrg(ctx.tx, orgId);
  const wasteId = crypto.randomUUID();
  let total = 0;
  for (const [leaf, q] of await explodeUsage(ctx.tx, input.locationId, new Map([[input.itemId, qty]]))) {
    total -= await applyMovement(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: input.locationId, itemId: leaf, qtyMilli: -q,
      reason: 'waste', businessDayId: input.businessDayId, refType: 'waste', refId: wasteId, note: input.reason, createdBy: ctx.actor.userId });
  }
  await postInventoryCost(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: input.locationId, businessDayId: input.businessDayId,
    entryDate: localDate(org.timezone), memo: `Waste: ${it.name} — ${input.reason}`, sourceType: 'waste', sourceId: wasteId,
    createdBy: ctx.actor.userId, byKey: new Map([[WASTE_KEY[input.wasteClass]!, total]]) });
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'stock.waste', entityType: 'stock_item', entityId: input.itemId, after: { ...input, valueMinor: total } });
  return { id: wasteId, valueMinor: total };
}

export async function listMovements(ctx: Ctx, orgId: string, locationId: string, itemId?: string) {
  requirePerm(ctx, 'inventory.view', orgId, locationId);
  return ctx.tx`select m.id, m.item_id, i.name as item_name, m.qty_base, m.value_minor, m.reason, m.note, m.created_at, m.ref_type, m.ref_id
    from inventory.movements m join inventory.items i on i.id = m.item_id
    where m.location_id = ${locationId} and (${itemId ?? null}::uuid is null or m.item_id = ${itemId ?? null})
    order by m.created_at desc limit 300`;
}

export async function createStockRequest(ctx: Ctx, orgId: string, input: { locationId: string; itemId?: string | null; note: string }) {
  requirePerm(ctx, 'inventory.request', orgId, input.locationId);
  await assertLocationInOrg(ctx.tx, orgId, input.locationId);
  const [r] = await ctx.tx<{ id: string }[]>`insert into inventory.stock_requests (tenant_id, org_id, location_id, item_id, note, requested_by)
    values (${ctx.tenantId}, ${orgId}, ${input.locationId}, ${input.itemId ?? null}, ${input.note}, ${ctx.actor.userId}) returning id`;
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'stock_request.created', entityType: 'stock_request', entityId: r!.id, after: input });
  return { id: r!.id };
}

export async function listStockRequests(ctx: Ctx, orgId: string, status: string) {
  requirePerm(ctx, 'inventory.view', orgId);
  return ctx.tx`select r.id, r.location_id, l.name as location_name, r.item_id, i.name as item_name, r.note, r.status, r.created_at, r.closed_at,
      coalesce(p.display_name, p.full_name, u.username) as requested_by_name
    from inventory.stock_requests r join core.locations l on l.id = r.location_id left join inventory.items i on i.id = r.item_id
    join core.users u on u.id = r.requested_by left join core.people p on p.id = u.person_id
    where r.org_id = ${orgId} and (${status} = 'all' or r.status = ${status}) order by r.created_at desc limit 200`;
}

export async function closeStockRequest(ctx: Ctx, orgId: string, id: string, status: 'done' | 'cancelled') {
  const [r] = await ctx.tx<{ location_id: string }[]>`select location_id from inventory.stock_requests where id = ${id} and org_id = ${orgId}`;
  if (!r) throw notFound('Stock request');
  requirePerm(ctx, 'inventory.request', orgId, r.location_id);
  await ctx.tx`update inventory.stock_requests set status = ${status}, closed_at = now() where id = ${id}`;
}

/**
 * Weekly physical count. For each item the system's expected quantity is stored next to the
 * counted actual (theory is never overwritten); the difference, up or down, is posted.
 */
export async function postCount(ctx: Ctx, orgId: string, input: { locationId: string; note?: string; lines: { itemId: string; counted: string; unit: string }[] }) {
  requirePerm(ctx, 'inventory.count', orgId, input.locationId);
  await assertLocationInOrg(ctx.tx, orgId, input.locationId);
  if (input.lines.length === 0) throw badRequest('empty_count', 'Count at least one item.');
  const org = await getOrg(ctx.tx, orgId);
  const [c] = await ctx.tx<{ id: string }[]>`insert into inventory.counts (tenant_id, org_id, location_id, status, note, created_by, posted_at, posted_by)
    values (${ctx.tenantId}, ${orgId}, ${input.locationId}, 'posted', ${input.note ?? null}, ${ctx.actor.userId}, now(), ${ctx.actor.userId}) returning id`;
  const countId = c!.id;
  let variance = 0;
  const summary = [];
  for (const l of input.lines) {
    const it = await itemRow(ctx.tx, orgId, l.itemId);
    if (it.kind !== 'stock') throw badRequest('not_stock_item', `Count varieties, not the group ${it.name}.`);
    const counted = toBaseMilli(l.counted, l.unit, it.dimension);
    if (counted < 0) throw badRequest('bad_qty', 'Counts cannot be negative.');
    const [lvl] = await ctx.tx<{ qty_base: string }[]>`select qty_base from inventory.stock_levels
      where location_id = ${input.locationId} and item_id = ${l.itemId} for update`;
    const expected = lvl ? toMilli(lvl.qty_base) : 0;
    const diff = counted - expected;
    const value = diff === 0 ? 0 : await applyMovement(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: input.locationId, itemId: l.itemId,
      qtyMilli: diff, reason: 'count_adjust', refType: 'count', refId: countId, note: diff < 0 ? 'Count shortage' : 'Count surplus',
      createdBy: ctx.actor.userId });
    variance += value;
    await ctx.tx`insert into inventory.count_lines (tenant_id, count_id, item_id, expected_qty, counted_qty, diff_qty, value_diff_minor)
      values (${ctx.tenantId}, ${countId}, ${l.itemId}, ${milliStr(expected)}, ${milliStr(counted)}, ${milliStr(diff)}, ${value})`;
    summary.push({ itemId: l.itemId, name: it.name, expected: milliStr(expected), counted: milliStr(counted), diff: milliStr(diff), valueMinor: value });
  }
  // Shortage (negative value) is a cost; surplus reduces it.
  await postInventoryCost(ctx.tx, { tenantId: ctx.tenantId, orgId, locationId: input.locationId, businessDayId: null,
    entryDate: localDate(org.timezone), memo: 'Weekly stock count difference', sourceType: 'stock_count', sourceId: countId,
    createdBy: ctx.actor.userId, byKey: new Map([['stock_variance', -variance]]) });
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action: 'stock.count_posted', entityType: 'stock_count', entityId: countId, after: summary });
  return { id: countId, varianceMinor: variance, lines: summary };
}

export async function listCounts(ctx: Ctx, orgId: string, locationId: string) {
  requirePerm(ctx, 'inventory.view', orgId, locationId);
  return ctx.tx`select c.id, c.created_at, c.note, coalesce(p.display_name, p.full_name, u.username) as counted_by,
      (select coalesce(sum(value_diff_minor), 0)::bigint from inventory.count_lines cl where cl.count_id = c.id) as variance_minor,
      (select json_agg(json_build_object('itemId', cl.item_id, 'name', i.name, 'expected', cl.expected_qty, 'counted', cl.counted_qty,
         'diff', cl.diff_qty, 'valueMinor', cl.value_diff_minor) order by i.name)
       from inventory.count_lines cl join inventory.items i on i.id = cl.item_id where cl.count_id = c.id) as lines
    from inventory.counts c join core.users u on u.id = c.created_by left join core.people p on p.id = u.person_id
    where c.location_id = ${locationId} order by c.created_at desc limit 52`;
}

export { toBaseMilli };
