-- 002_catalog_inventory: menu engine (items, sizes, modifiers, deals, taxes),
-- units, stock items, recipes, sub-mixes, stock levels and movements.

create schema if not exists catalog;
create schema if not exists inventory;

-- Units: every quantity is stored in its dimension's base unit (g, ml, unit).
-- factor = how many base units one of this unit holds. Exact numerics, no floats.
create table catalog.units (
  code      text primary key,
  name      text not null,
  dimension text not null check (dimension in ('mass', 'volume', 'count')),
  factor    numeric(20, 6) not null check (factor > 0)
);
insert into catalog.units (code, name, dimension, factor) values
  ('mg',    'milligram',  'mass',   0.001),
  ('g',     'gram',       'mass',   1),
  ('kg',    'kilogram',   'mass',   1000),
  ('maund', 'maund (40 kg)', 'mass', 40000),
  ('ml',    'millilitre', 'volume', 1),
  ('l',     'litre',      'volume', 1000),
  ('unit',  'unit',       'count',  1),
  ('dozen', 'dozen',      'count',  12);

create table catalog.menu_categories (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id),
  org_id    uuid not null references core.organizations(id),
  name      text not null,
  kind      text not null check (kind in ('food', 'beverage')),
  sort      int not null default 0,
  unique (org_id, name)
);

create table catalog.menu_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id),
  org_id      uuid not null references core.organizations(id),
  category_id uuid not null references catalog.menu_categories(id),
  name        text not null,
  description text,
  image       text,
  enabled     boolean not null default false,
  is_deal     boolean not null default false,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);

-- Sizes / price categories (plate sizes, small-medium-large, can/250ml...).
-- open_price: a custom amount; its recipe is defined for recipe_basis_minor and scales linearly.
create table catalog.menu_variants (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenants(id),
  org_id             uuid not null references core.organizations(id),
  menu_item_id       uuid not null references catalog.menu_items(id),
  name               text not null,
  size_tag           text,
  price_minor        bigint not null default 0 check (price_minor >= 0),
  open_price         boolean not null default false,
  recipe_basis_minor bigint check (recipe_basis_minor is null or recipe_basis_minor > 0),
  enabled            boolean not null default true,
  sort               int not null default 0,
  check (not open_price or recipe_basis_minor is not null),
  unique (menu_item_id, name)
);

-- Location-level override of what a stall sells. Absent row = follow item.enabled.
create table catalog.location_menu (
  tenant_id    uuid not null references core.tenants(id),
  location_id  uuid not null references core.locations(id),
  menu_item_id uuid not null references catalog.menu_items(id),
  enabled      boolean not null,
  primary key (location_id, menu_item_id)
);

create table catalog.modifier_groups (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id),
  org_id     uuid not null references core.organizations(id),
  name       text not null,
  min_select int not null default 0,
  max_select int not null default 1,
  unique (org_id, name)
);

create table catalog.modifiers (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id),
  group_id          uuid not null references catalog.modifier_groups(id),
  name              text not null,
  price_delta_minor bigint not null default 0,
  enabled           boolean not null default true,
  sort              int not null default 0,
  unique (group_id, name)
);

create table catalog.item_modifier_groups (
  tenant_id    uuid not null references core.tenants(id),
  menu_item_id uuid not null references catalog.menu_items(id),
  group_id     uuid not null references catalog.modifier_groups(id),
  primary key (menu_item_id, group_id)
);

-- Deals bundle several variants at one combo price.
create table catalog.deal_components (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references core.tenants(id),
  deal_variant_id      uuid not null references catalog.menu_variants(id),
  component_variant_id uuid not null references catalog.menu_variants(id),
  qty                  int not null default 1 check (qty > 0),
  check (deal_variant_id <> component_variant_id)
);

create table catalog.tax_rates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id),
  org_id     uuid not null references core.organizations(id),
  name       text not null,
  rate_bps   int not null check (rate_bps >= 0 and rate_bps <= 10000),
  applies_to text not null default 'all' check (applies_to in ('all', 'card')),
  inclusive  boolean not null default false,
  enabled    boolean not null default false,
  unique (org_id, name)
);

-- Stock items. kind: stock = held in stock; mix = sub-mix of other items (coating);
-- family = a grouping like "Potato" whose stock lives on its varieties (Santos, Santa...).
create table inventory.items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id),
  org_id       uuid not null references core.organizations(id),
  parent_id    uuid references inventory.items(id),
  name         text not null,
  category     text not null,
  kind         text not null default 'stock' check (kind in ('stock', 'mix', 'family')),
  dimension    text not null check (dimension in ('mass', 'volume', 'count')),
  purchase_unit text not null references catalog.units(code),
  tracking     text not null default 'precise' check (tracking in ('precise', 'bulk')),
  cost_class   text not null default 'food' check (cost_class in ('food', 'beverage', 'packaging', 'fuel')),
  low_stock_base numeric(18, 3),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (org_id, name)
);

-- Mix recipe: qty of each component (in its base unit) per 1000 base units of the mix.
create table inventory.mix_components (
  tenant_id         uuid not null references core.tenants(id),
  mix_id            uuid not null references inventory.items(id),
  component_item_id uuid not null references inventory.items(id),
  per_1000_base     numeric(18, 3) not null check (per_1000_base > 0),
  primary key (mix_id, component_item_id),
  check (mix_id <> component_item_id)
);

-- Which variety of a family a location is currently using (e.g. Potato -> Santos).
create table inventory.location_varieties (
  tenant_id      uuid not null references core.tenants(id),
  location_id    uuid not null references core.locations(id),
  family_item_id uuid not null references inventory.items(id),
  variety_item_id uuid not null references inventory.items(id),
  primary key (location_id, family_item_id)
);

-- Recipe card per sellable size. stage: prep (coating), fry (potato), serve (masala, sauces, packaging).
create table inventory.recipe_lines (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id),
  variant_id uuid not null references catalog.menu_variants(id),
  item_id    uuid not null references inventory.items(id),
  qty_base   numeric(18, 3) not null check (qty_base > 0),
  stage      text not null default 'fry' check (stage in ('prep', 'fry', 'serve')),
  unique (variant_id, item_id)
);

create table inventory.modifier_recipe_lines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id),
  modifier_id uuid not null references catalog.modifiers(id),
  item_id     uuid not null references inventory.items(id),
  qty_base    numeric(18, 3) not null check (qty_base > 0),
  unique (modifier_id, item_id)
);

-- Running stock per location and item. value_minor is the carried cost (moving average),
-- so average cost = value_minor / qty_base and totals never drift from rounding.
create table inventory.stock_levels (
  tenant_id   uuid not null references core.tenants(id),
  org_id      uuid not null references core.organizations(id),
  location_id uuid not null references core.locations(id),
  item_id     uuid not null references inventory.items(id),
  qty_base    numeric(18, 3) not null default 0,
  value_minor bigint not null default 0,
  low_notified boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (location_id, item_id)
);

create table inventory.movements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id),
  org_id          uuid not null references core.organizations(id),
  location_id     uuid not null references core.locations(id),
  item_id         uuid not null references inventory.items(id),
  business_day_id uuid,
  qty_base        numeric(18, 3) not null,
  value_minor     bigint not null,
  reason          text not null check (reason in ('purchase', 'sale', 'void', 'waste', 'count_adjust', 'opening', 'correction')),
  ref_type        text,
  ref_id          uuid,
  ref_line_id     uuid,
  note            text,
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index movements_ref_line_idx on inventory.movements (ref_line_id);
create index movements_loc_item_idx on inventory.movements (location_id, item_id, created_at);
create trigger movements_immutable before update or delete on inventory.movements
  for each row execute function core.forbid_change();

create table inventory.stock_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id),
  org_id          uuid not null references core.organizations(id),
  location_id     uuid not null references core.locations(id),
  item_id         uuid references inventory.items(id),
  note            text not null,
  status          text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  requested_by    uuid not null references core.users(id),
  created_at      timestamptz not null default now(),
  closed_at       timestamptz
);

-- Weekly physical count. expected_qty is the system's theoretical figure, kept forever
-- next to the counted actual; the difference (up or down) is posted as a variance.
create table inventory.counts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id),
  org_id      uuid not null references core.organizations(id),
  location_id uuid not null references core.locations(id),
  status      text not null default 'draft' check (status in ('draft', 'posted')),
  note        text,
  created_by  uuid not null references core.users(id),
  created_at  timestamptz not null default now(),
  posted_at   timestamptz,
  posted_by   uuid references core.users(id)
);

create table inventory.count_lines (
  tenant_id        uuid not null references core.tenants(id),
  count_id         uuid not null references inventory.counts(id),
  item_id          uuid not null references inventory.items(id),
  expected_qty     numeric(18, 3),
  counted_qty      numeric(18, 3) not null check (counted_qty >= 0),
  diff_qty         numeric(18, 3),
  value_diff_minor bigint,
  primary key (count_id, item_id)
);
