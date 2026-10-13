import { mulDiv, toMilli } from '../../core/math.js';
import type { Tx } from '../../db/db.js';
import { dealComponents } from '../catalog/index.js';
import { usersWithPermission } from '../identity/index.js';
import { notify } from '../notifications/index.js';

// Stock engine. Quantities are integer milli-base-units; value is integer minor units.
// Each (location, item) carries qty and total value, so the moving-average cost is always
// value / qty and depleting stock never creates or loses a paisa through rounding.

export type MovementReason = 'purchase' | 'sale' | 'void' | 'waste' | 'count_adjust' | 'opening' | 'correction';

export interface MovementInput {
  tenantId: string;
  orgId: string;
  locationId: string;
  itemId: string;
  qtyMilli: number;
  /** Required for priced inflows (purchases, reversals); computed for outflows. */
  valueMinor?: number;
  reason: MovementReason;
  businessDayId?: string | null;
  refType?: string;
  refId?: string;
  refLineId?: string;
  note?: string;
  createdBy?: string | null;
}

interface Level { qty: number; value: number; low: number | null; lowNotified: boolean; name: string }

async function lockLevel(tx: Tx, m: MovementInput): Promise<Level> {
  await tx`insert into inventory.stock_levels (tenant_id, org_id, location_id, item_id)
    values (${m.tenantId}, ${m.orgId}, ${m.locationId}, ${m.itemId}) on conflict (location_id, item_id) do nothing`;
  const [r] = await tx<{ qty_base: string; value_minor: number; low_stock_base: string | null; low_notified: boolean; name: string }[]>`
    select s.qty_base, s.value_minor, i.low_stock_base, s.low_notified, i.name
    from inventory.stock_levels s join inventory.items i on i.id = s.item_id
    where s.location_id = ${m.locationId} and s.item_id = ${m.itemId} for update of s`;
  return { qty: toMilli(r!.qty_base), value: r!.value_minor, low: r!.low_stock_base === null ? null : toMilli(r!.low_stock_base),
    lowNotified: r!.low_notified, name: r!.name };
}

/** Cost of qtyMilli at the latest known purchase price (used when stock on hand is zero or negative). */
export async function lastCost(tx: Tx, itemId: string, qtyMilli: number): Promise<number> {
  const [p] = await tx<{ qty_base: string; value_minor: number }[]>`
    select qty_base, value_minor from inventory.movements
    where item_id = ${itemId} and reason = 'purchase' and qty_base > 0 order by created_at desc limit 1`;
  if (!p) return 0;
  return mulDiv(qtyMilli, p.value_minor, toMilli(p.qty_base));
}

/** Cost of taking qtyMilli (> 0) out of a level, by moving average, falling back to last purchase price. */
async function outflowCost(tx: Tx, itemId: string, level: Level, qtyMilli: number): Promise<number> {
  if (level.qty > 0 && qtyMilli <= level.qty) return mulDiv(level.value, qtyMilli, level.qty);
  if (level.qty > 0) {
    // Part from stock on hand, the rest (stock going negative) at last purchase price.
    return level.value + (await lastCost(tx, itemId, qtyMilli - level.qty));
  }
  return lastCost(tx, itemId, qtyMilli);
}

/** Current average cost of qtyMilli (for valuing surpluses found at a count). */
export async function averageCost(tx: Tx, locationId: string, itemId: string, qtyMilli: number): Promise<number> {
  const [r] = await tx<{ qty_base: string; value_minor: number }[]>`
    select qty_base, value_minor from inventory.stock_levels where location_id = ${locationId} and item_id = ${itemId}`;
  if (r && toMilli(r.qty_base) > 0) return mulDiv(r.value_minor, qtyMilli, toMilli(r.qty_base));
  return lastCost(tx, itemId, qtyMilli);
}

/** Apply one stock movement; returns the signed value moved (negative for outflows). */
export async function applyMovement(tx: Tx, m: MovementInput): Promise<number> {
  if (m.qtyMilli === 0) return 0;
  const level = await lockLevel(tx, m);
  let value: number;
  if (m.qtyMilli < 0) {
    value = m.valueMinor ?? -(await outflowCost(tx, m.itemId, level, -m.qtyMilli));
  } else {
    value = m.valueMinor ?? (await averageCost(tx, m.locationId, m.itemId, m.qtyMilli));
  }
  const newQty = level.qty + m.qtyMilli;
  const newValue = level.value + value;
  const qtyStr = milliStr(m.qtyMilli);
  await tx`insert into inventory.movements (tenant_id, org_id, location_id, item_id, business_day_id, qty_base, value_minor, reason,
      ref_type, ref_id, ref_line_id, note, created_by)
    values (${m.tenantId}, ${m.orgId}, ${m.locationId}, ${m.itemId}, ${m.businessDayId ?? null}, ${qtyStr}, ${value}, ${m.reason},
      ${m.refType ?? null}, ${m.refId ?? null}, ${m.refLineId ?? null}, ${m.note ?? null},
      ${m.createdBy && m.createdBy !== '00000000-0000-0000-0000-000000000000' ? m.createdBy : null})`;
  const isLow = level.low !== null && newQty <= level.low;
  await tx`update inventory.stock_levels set qty_base = ${milliStr(newQty)}, value_minor = ${newValue}, updated_at = now(),
      low_notified = ${isLow ? level.lowNotified : false}
    where location_id = ${m.locationId} and item_id = ${m.itemId}`;
  if (isLow && !level.lowNotified) {
    await tx`update inventory.stock_levels set low_notified = true where location_id = ${m.locationId} and item_id = ${m.itemId}`;
    const users = [
      ...(await usersWithPermission(tx, m.orgId, 'inventory.request', m.locationId)),
      ...(await usersWithPermission(tx, m.orgId, 'approve.purchase', m.locationId)),
    ];
    await notify(tx, { tenantId: m.tenantId, orgId: m.orgId, userIds: users, type: 'low_stock',
      title: `Low stock: ${level.name}`, body: 'Running low — raise a stock request or buy more.', link: '/inventory',
      dedupeKey: `low:${m.locationId}:${m.itemId}:${new Date().toISOString().slice(0, 10)}` });
  }
  return value;
}

export function milliStr(milli: number): string {
  const neg = milli < 0;
  const a = Math.abs(milli);
  return `${neg ? '-' : ''}${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, '0')}`;
}

// ---- Recipe explosion: what a sale uses, down to raw stock items ----

interface ItemNode { id: string; kind: 'stock' | 'mix' | 'family'; cost_class: string }

/**
 * Expand usage of items into leaf stock items: a mix becomes its components (in set proportions),
 * a family (e.g. Potato) becomes the variety this location is using (e.g. Santos).
 */
export async function explodeUsage(tx: Tx, locationId: string, usage: Map<string, number>, depth = 0): Promise<Map<string, number>> {
  if (depth > 5) throw new Error('mix nesting too deep (possible cycle)');
  const out = new Map<string, number>();
  const add = (id: string, q: number) => out.set(id, (out.get(id) ?? 0) + q);
  for (const [itemId, qty] of usage) {
    if (qty === 0) continue;
    const [it] = await tx<ItemNode[]>`select id, kind, cost_class from inventory.items where id = ${itemId}`;
    if (!it) continue;
    if (it.kind === 'stock') {
      add(itemId, qty);
    } else if (it.kind === 'mix') {
      const comps = await tx<{ component_item_id: string; per_1000_base: string }[]>`
        select component_item_id, per_1000_base from inventory.mix_components where mix_id = ${itemId}`;
      const inner = new Map<string, number>();
      for (const c of comps) inner.set(c.component_item_id, mulDiv(qty, toMilli(c.per_1000_base), 1_000_000));
      for (const [k, v] of await explodeUsage(tx, locationId, inner, depth + 1)) add(k, v);
    } else {
      const variety = await varietyFor(tx, locationId, itemId);
      if (variety) for (const [k, v] of await explodeUsage(tx, locationId, new Map([[variety, qty]]), depth + 1)) add(k, v);
    }
  }
  return out;
}

/** The variety in use at a location, else the variety with most stock, else the first one. */
export async function varietyFor(tx: Tx, locationId: string, familyId: string): Promise<string | null> {
  const [pref] = await tx<{ variety_item_id: string }[]>`
    select variety_item_id from inventory.location_varieties where location_id = ${locationId} and family_item_id = ${familyId}`;
  if (pref) return pref.variety_item_id;
  const [best] = await tx<{ id: string }[]>`
    select i.id from inventory.items i left join inventory.stock_levels s on s.item_id = i.id and s.location_id = ${locationId}
    where i.parent_id = ${familyId} and i.active order by coalesce(s.qty_base, 0) desc, i.name limit 1`;
  return best?.id ?? null;
}

/** Recipe usage for one sellable size (milli-base per one unit sold), including deal components. */
export async function variantUsage(tx: Tx, variantId: string, depth = 0): Promise<Map<string, number>> {
  if (depth > 3) throw new Error('deal nesting too deep');
  const out = new Map<string, number>();
  const lines = await tx<{ item_id: string; qty_base: string }[]>`
    select item_id, qty_base from inventory.recipe_lines where variant_id = ${variantId}`;
  for (const l of lines) out.set(l.item_id, (out.get(l.item_id) ?? 0) + toMilli(l.qty_base));
  const comps = await dealComponents(tx, variantId);
  for (const c of comps) {
    for (const [k, v] of await variantUsage(tx, c.component_variant_id, depth + 1)) out.set(k, (out.get(k) ?? 0) + v * c.qty);
  }
  return out;
}

export async function modifierUsage(tx: Tx, modifierId: string): Promise<Map<string, number>> {
  const rows = await tx<{ item_id: string; qty_base: string }[]>`
    select item_id, qty_base from inventory.modifier_recipe_lines where modifier_id = ${modifierId}`;
  return new Map(rows.map((r) => [r.item_id, toMilli(r.qty_base)]));
}
