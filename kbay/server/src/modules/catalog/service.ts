import { audit } from '../../core/audit.js';
import type { Ctx } from '../../core/context.js';
import { requirePerm } from '../../core/context.js';
import { badRequest, notFound } from '../../core/errors.js';
import type { Tx } from '../../db/db.js';

// The menu engine: categories, items (pre-seeded, enabled per org and per location),
// sizes/price categories, modifiers that change the price, deals, and taxes.

export async function menu(tx: Tx, orgId: string, opts: { locationId?: string; includeDisabled?: boolean }) {
  const loc = opts.locationId ?? null;
  const all = opts.includeDisabled ?? false;
  const categories = await tx<{ id: string; name: string; kind: string; sort: number }[]>`
    select id, name, kind, sort from catalog.menu_categories where org_id = ${orgId} order by sort, name`;
  const items = await tx<{ id: string; category_id: string; name: string; description: string | null; image: string | null;
    enabled: boolean; is_deal: boolean; sort: number; location_enabled: boolean | null }[]>`
    select i.id, i.category_id, i.name, i.description, i.image, i.enabled, i.is_deal, i.sort,
           lm.enabled as location_enabled
    from catalog.menu_items i
    left join catalog.location_menu lm on lm.menu_item_id = i.id and lm.location_id = ${loc}
    where i.org_id = ${orgId}
      and (${all} or coalesce(lm.enabled, i.enabled))
    order by i.sort, i.name`;
  const variants = await tx<{ id: string; menu_item_id: string; name: string; size_tag: string | null; price_minor: number;
    open_price: boolean; recipe_basis_minor: number | null; enabled: boolean; sort: number; has_recipe: boolean }[]>`
    select v.id, v.menu_item_id, v.name, v.size_tag, v.price_minor, v.open_price, v.recipe_basis_minor, v.enabled, v.sort,
           exists (select 1 from inventory.recipe_lines r where r.variant_id = v.id)
             or exists (select 1 from catalog.deal_components d where d.deal_variant_id = v.id) as has_recipe
    from catalog.menu_variants v where v.org_id = ${orgId} and (${all} or v.enabled)
    order by v.sort, v.price_minor`;
  const groups = await tx<{ menu_item_id: string; id: string; name: string; min_select: number; max_select: number }[]>`
    select img.menu_item_id, g.id, g.name, g.min_select, g.max_select
    from catalog.item_modifier_groups img join catalog.modifier_groups g on g.id = img.group_id
    where g.org_id = ${orgId}`;
  const modifiers = await tx<{ id: string; group_id: string; name: string; price_delta_minor: number; enabled: boolean }[]>`
    select m.id, m.group_id, m.name, m.price_delta_minor, m.enabled from catalog.modifiers m
    join catalog.modifier_groups g on g.id = m.group_id where g.org_id = ${orgId} and (${all} or m.enabled) order by m.sort, m.name`;
  const deals = await tx<{ deal_variant_id: string; component_variant_id: string; qty: number }[]>`
    select d.deal_variant_id, d.component_variant_id, d.qty from catalog.deal_components d
    join catalog.menu_variants v on v.id = d.deal_variant_id where v.org_id = ${orgId}`;

  return categories
    .map((c) => ({
      ...c,
      items: items
        .filter((i) => i.category_id === c.id)
        .map((i) => ({
          ...i,
          variants: variants.filter((v) => v.menu_item_id === i.id).map((v) => ({
            ...v,
            components: deals.filter((d) => d.deal_variant_id === v.id).map((d) => ({ variantId: d.component_variant_id, qty: d.qty })),
          })),
          modifierGroups: groups.filter((g) => g.menu_item_id === i.id).map((g) => ({
            ...g,
            modifiers: modifiers.filter((m) => m.group_id === g.id),
          })),
        }))
        .filter((i) => all || i.variants.length > 0),
    }))
    .filter((c) => all || c.items.length > 0);
}

export interface PriceRequestLine {
  variantId: string;
  qty: number;
  modifierIds?: string[];
  /** For a custom-amount size: the amount the customer pays per unit. */
  openPriceMinor?: number;
}

export interface PricedLine {
  variantId: string;
  menuItemId: string;
  itemName: string;
  variantName: string;
  categoryName: string;
  qty: number;
  unitPriceMinor: number;
  modifiers: { id: string; name: string; priceDeltaMinor: number }[];
  lineTotalMinor: number;
}

/** Price POS lines from the current menu; rejects anything not sold at this location. */
export async function priceLines(tx: Tx, orgId: string, locationId: string, lines: PriceRequestLine[]): Promise<PricedLine[]> {
  const out: PricedLine[] = [];
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0 || l.qty > 1000) throw badRequest('bad_qty', 'Count must be a whole number from 1 to 1000.');
    const [v] = await tx<{ id: string; menu_item_id: string; name: string; price_minor: number; open_price: boolean; v_enabled: boolean;
      item_name: string; category_name: string; sellable: boolean }[]>`
      select v.id, v.menu_item_id, v.name, v.price_minor, v.open_price, v.enabled as v_enabled, i.name as item_name, c.name as category_name,
             coalesce(lm.enabled, i.enabled) as sellable
      from catalog.menu_variants v join catalog.menu_items i on i.id = v.menu_item_id
      join catalog.menu_categories c on c.id = i.category_id
      left join catalog.location_menu lm on lm.menu_item_id = i.id and lm.location_id = ${locationId}
      where v.id = ${l.variantId} and v.org_id = ${orgId}`;
    if (!v) throw badRequest('unknown_item', 'An item on this sale is not on the menu.');
    if (!v.v_enabled || !v.sellable) throw badRequest('item_disabled', `${v.item_name} (${v.name}) is not sold here.`);
    let unit = v.price_minor;
    if (v.open_price) {
      if (!l.openPriceMinor || !Number.isInteger(l.openPriceMinor) || l.openPriceMinor <= 0) {
        throw badRequest('amount_required', `Enter the amount for ${v.item_name} (${v.name}).`);
      }
      unit = l.openPriceMinor;
    }
    const mods: PricedLine['modifiers'] = [];
    const modIds = [...new Set(l.modifierIds ?? [])];
    if (modIds.length) {
      const rows = await tx<{ id: string; name: string; price_delta_minor: number; group_id: string; max_select: number }[]>`
        select m.id, m.name, m.price_delta_minor, m.group_id, g.max_select from catalog.modifiers m
        join catalog.modifier_groups g on g.id = m.group_id
        join catalog.item_modifier_groups img on img.group_id = g.id and img.menu_item_id = ${v.menu_item_id}
        where m.id = any(${modIds}::uuid[]) and m.enabled`;
      if (rows.length !== modIds.length) throw badRequest('bad_modifier', 'An option is not available for this item.');
      const perGroup = new Map<string, number>();
      for (const r of rows) {
        perGroup.set(r.group_id, (perGroup.get(r.group_id) ?? 0) + 1);
        if (perGroup.get(r.group_id)! > r.max_select) throw badRequest('too_many_options', 'Too many options picked in one group.');
        mods.push({ id: r.id, name: r.name, priceDeltaMinor: r.price_delta_minor });
        unit += r.price_delta_minor;
      }
    }
    if (unit < 0) throw badRequest('negative_price', 'Price cannot go below zero.');
    out.push({
      variantId: v.id, menuItemId: v.menu_item_id, itemName: v.item_name, variantName: v.name, categoryName: v.category_name,
      qty: l.qty, unitPriceMinor: unit, modifiers: mods, lineTotalMinor: unit * l.qty,
    });
  }
  return out;
}

export async function enabledTaxes(tx: Tx, orgId: string) {
  return tx<{ id: string; name: string; rate_bps: number; applies_to: 'all' | 'card'; inclusive: boolean }[]>`
    select id, name, rate_bps, applies_to, inclusive from catalog.tax_rates where org_id = ${orgId} and enabled order by name`;
}

// ---- Management ----

async function auditMenu(ctx: Ctx, orgId: string, action: string, entityType: string, entityId: string, after: unknown, before?: unknown) {
  await audit(ctx.tx, { tenantId: ctx.tenantId, orgId, actorUserId: ctx.actor.userId, action, entityType, entityId, before, after });
}

export async function upsertCategory(ctx: Ctx, orgId: string, input: { id?: string; name: string; kind: 'food' | 'beverage'; sort?: number }) {
  requirePerm(ctx, 'menu.manage', orgId);
  if (input.id) {
    await ctx.tx`update catalog.menu_categories set name = ${input.name}, kind = ${input.kind}, sort = ${input.sort ?? 0}
      where id = ${input.id} and org_id = ${orgId}`;
    await auditMenu(ctx, orgId, 'menu.category_updated', 'menu_category', input.id, input);
    return { id: input.id };
  }
  const [r] = await ctx.tx<{ id: string }[]>`insert into catalog.menu_categories (tenant_id, org_id, name, kind, sort)
    values (${ctx.tenantId}, ${orgId}, ${input.name}, ${input.kind}, ${input.sort ?? 0}) returning id`;
  await auditMenu(ctx, orgId, 'menu.category_created', 'menu_category', r!.id, input);
  return { id: r!.id };
}

export async function upsertItem(ctx: Ctx, orgId: string, input: { id?: string; categoryId: string; name: string; description?: string | null;
  image?: string | null; enabled: boolean; isDeal?: boolean; sort?: number }) {
  requirePerm(ctx, 'menu.manage', orgId);
  if (input.id) {
    const [before] = await ctx.tx`select * from catalog.menu_items where id = ${input.id} and org_id = ${orgId}`;
    if (!before) throw notFound('Menu item');
    await ctx.tx`update catalog.menu_items set category_id = ${input.categoryId}, name = ${input.name}, description = ${input.description ?? null},
      image = ${input.image ?? null}, enabled = ${input.enabled}, is_deal = ${input.isDeal ?? before.is_deal}, sort = ${input.sort ?? before.sort}
      where id = ${input.id}`;
    await auditMenu(ctx, orgId, 'menu.item_updated', 'menu_item', input.id, input, before);
    return { id: input.id };
  }
  const [r] = await ctx.tx<{ id: string }[]>`insert into catalog.menu_items (tenant_id, org_id, category_id, name, description, image, enabled, is_deal, sort)
    values (${ctx.tenantId}, ${orgId}, ${input.categoryId}, ${input.name}, ${input.description ?? null}, ${input.image ?? null},
      ${input.enabled}, ${input.isDeal ?? false}, ${input.sort ?? 0}) returning id`;
  await auditMenu(ctx, orgId, 'menu.item_created', 'menu_item', r!.id, input);
  return { id: r!.id };
}

export async function setItemEnabled(ctx: Ctx, orgId: string, itemId: string, enabled: boolean) {
  requirePerm(ctx, 'menu.manage', orgId);
  const r = await ctx.tx`update catalog.menu_items set enabled = ${enabled} where id = ${itemId} and org_id = ${orgId}`;
  if (r.count === 0) throw notFound('Menu item');
  await auditMenu(ctx, orgId, enabled ? 'menu.item_enabled' : 'menu.item_disabled', 'menu_item', itemId, { enabled });
}

/** Location override: true/false, or null to follow the organization setting. */
export async function setLocationItem(ctx: Ctx, orgId: string, locationId: string, itemId: string, enabled: boolean | null) {
  requirePerm(ctx, 'menu.manage', orgId, locationId);
  if (enabled === null) await ctx.tx`delete from catalog.location_menu where location_id = ${locationId} and menu_item_id = ${itemId}`;
  else await ctx.tx`insert into catalog.location_menu (tenant_id, location_id, menu_item_id, enabled) values (${ctx.tenantId}, ${locationId}, ${itemId}, ${enabled})
    on conflict (location_id, menu_item_id) do update set enabled = excluded.enabled`;
  await auditMenu(ctx, orgId, 'menu.location_override', 'menu_item', itemId, { locationId, enabled });
}

export async function upsertVariant(ctx: Ctx, orgId: string, input: { id?: string; menuItemId: string; name: string; sizeTag?: string | null;
  priceMinor: number; openPrice?: boolean; recipeBasisMinor?: number | null; enabled?: boolean; sort?: number }) {
  requirePerm(ctx, 'menu.manage', orgId);
  if (input.openPrice && !input.recipeBasisMinor) throw badRequest('basis_required', 'A custom-amount size needs the amount its recipe is defined for.');
  if (input.id) {
    const [before] = await ctx.tx`select * from catalog.menu_variants where id = ${input.id} and org_id = ${orgId}`;
    if (!before) throw notFound('Size');
    await ctx.tx`update catalog.menu_variants set name = ${input.name}, size_tag = ${input.sizeTag ?? null}, price_minor = ${input.priceMinor},
      open_price = ${input.openPrice ?? false}, recipe_basis_minor = ${input.recipeBasisMinor ?? null}, enabled = ${input.enabled ?? true},
      sort = ${input.sort ?? before.sort} where id = ${input.id}`;
    await auditMenu(ctx, orgId, 'menu.size_updated', 'menu_variant', input.id, input, before);
    return { id: input.id };
  }
  const [r] = await ctx.tx<{ id: string }[]>`insert into catalog.menu_variants (tenant_id, org_id, menu_item_id, name, size_tag, price_minor,
      open_price, recipe_basis_minor, enabled, sort)
    values (${ctx.tenantId}, ${orgId}, ${input.menuItemId}, ${input.name}, ${input.sizeTag ?? null}, ${input.priceMinor},
      ${input.openPrice ?? false}, ${input.recipeBasisMinor ?? null}, ${input.enabled ?? true}, ${input.sort ?? 0}) returning id`;
  await auditMenu(ctx, orgId, 'menu.size_created', 'menu_variant', r!.id, input);
  return { id: r!.id };
}

export async function setDealComponents(ctx: Ctx, orgId: string, dealVariantId: string, components: { variantId: string; qty: number }[]) {
  requirePerm(ctx, 'menu.manage', orgId);
  await ctx.tx`delete from catalog.deal_components where deal_variant_id = ${dealVariantId}`;
  for (const c of components) {
    await ctx.tx`insert into catalog.deal_components (tenant_id, deal_variant_id, component_variant_id, qty)
      values (${ctx.tenantId}, ${dealVariantId}, ${c.variantId}, ${c.qty})`;
  }
  await auditMenu(ctx, orgId, 'menu.deal_updated', 'menu_variant', dealVariantId, components);
}

export async function upsertModifierGroup(ctx: Ctx, orgId: string, input: { id?: string; name: string; minSelect: number; maxSelect: number;
  modifiers: { id?: string; name: string; priceDeltaMinor: number; enabled?: boolean }[]; itemIds: string[] }) {
  requirePerm(ctx, 'menu.manage', orgId);
  let id = input.id;
  if (id) {
    await ctx.tx`update catalog.modifier_groups set name = ${input.name}, min_select = ${input.minSelect}, max_select = ${input.maxSelect}
      where id = ${id} and org_id = ${orgId}`;
  } else {
    const [r] = await ctx.tx<{ id: string }[]>`insert into catalog.modifier_groups (tenant_id, org_id, name, min_select, max_select)
      values (${ctx.tenantId}, ${orgId}, ${input.name}, ${input.minSelect}, ${input.maxSelect}) returning id`;
    id = r!.id;
  }
  for (const [i, m] of input.modifiers.entries()) {
    if (m.id) await ctx.tx`update catalog.modifiers set name = ${m.name}, price_delta_minor = ${m.priceDeltaMinor}, enabled = ${m.enabled ?? true}, sort = ${i}
      where id = ${m.id} and group_id = ${id}`;
    else await ctx.tx`insert into catalog.modifiers (tenant_id, group_id, name, price_delta_minor, enabled, sort)
      values (${ctx.tenantId}, ${id}, ${m.name}, ${m.priceDeltaMinor}, ${m.enabled ?? true}, ${i})`;
  }
  await ctx.tx`delete from catalog.item_modifier_groups where group_id = ${id}`;
  for (const itemId of input.itemIds) {
    await ctx.tx`insert into catalog.item_modifier_groups (tenant_id, menu_item_id, group_id) values (${ctx.tenantId}, ${itemId}, ${id})`;
  }
  await auditMenu(ctx, orgId, 'menu.modifiers_updated', 'modifier_group', id!, input);
  return { id };
}

export async function listTaxes(ctx: Ctx, orgId: string) {
  return ctx.tx`select id, name, rate_bps, applies_to, inclusive, enabled from catalog.tax_rates where org_id = ${orgId} order by name`;
}

export async function upsertTax(ctx: Ctx, orgId: string, input: { id?: string; name: string; rateBps: number; appliesTo: 'all' | 'card'; inclusive: boolean; enabled: boolean }) {
  requirePerm(ctx, 'menu.manage', orgId);
  if (input.id) {
    await ctx.tx`update catalog.tax_rates set name = ${input.name}, rate_bps = ${input.rateBps}, applies_to = ${input.appliesTo},
      inclusive = ${input.inclusive}, enabled = ${input.enabled} where id = ${input.id} and org_id = ${orgId}`;
    await auditMenu(ctx, orgId, 'tax.updated', 'tax_rate', input.id, input);
    return { id: input.id };
  }
  const [r] = await ctx.tx<{ id: string }[]>`insert into catalog.tax_rates (tenant_id, org_id, name, rate_bps, applies_to, inclusive, enabled)
    values (${ctx.tenantId}, ${orgId}, ${input.name}, ${input.rateBps}, ${input.appliesTo}, ${input.inclusive}, ${input.enabled}) returning id`;
  await auditMenu(ctx, orgId, 'tax.created', 'tax_rate', r!.id, input);
  return { id: r!.id };
}

export async function variantInfo(tx: Tx, variantId: string) {
  const [v] = await tx<{ id: string; org_id: string; open_price: boolean; recipe_basis_minor: number | null; price_minor: number; kind: string }[]>`
    select v.id, v.org_id, v.open_price, v.recipe_basis_minor, v.price_minor, c.kind
    from catalog.menu_variants v join catalog.menu_items i on i.id = v.menu_item_id join catalog.menu_categories c on c.id = i.category_id
    where v.id = ${variantId}`;
  return v ?? null;
}

export async function dealComponents(tx: Tx, variantId: string) {
  return tx<{ component_variant_id: string; qty: number }[]>`
    select component_variant_id, qty from catalog.deal_components where deal_variant_id = ${variantId}`;
}
