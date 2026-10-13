-- 003_orders: order management, kept in its own schema with no foreign keys into other
-- modules' tables, so it can be lifted onto its own server. It talks to the rest of the
-- system only through its outbox (events) and injected ports.

create schema if not exists orders;

create table orders.orders (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  org_id             uuid not null,
  location_id        uuid not null,
  business_day_id    uuid not null,
  business_date      date not null,
  order_no           int  not null,
  status             text not null default 'completed' check (status in ('completed', 'voided')),
  subtotal_minor     bigint not null check (subtotal_minor >= 0),
  tax_minor          bigint not null default 0 check (tax_minor >= 0),
  total_minor        bigint not null check (total_minor >= 0),
  refunded_minor     bigint not null default 0 check (refunded_minor >= 0),
  payment_account_id uuid not null,
  payment_kind       text not null,
  tax_lines          jsonb not null default '[]'::jsonb,
  note               text,
  client_ref         uuid unique,
  created_by         uuid not null,
  created_at         timestamptz not null default now(),
  voided_at          timestamptz,
  voided_by          uuid,
  void_reason        text,
  check (refunded_minor <= total_minor),
  check (status <> 'voided' or (void_reason is not null and length(trim(void_reason)) > 0)),
  unique (location_id, business_day_id, order_no)
);
create index orders_day_idx on orders.orders (business_day_id);

create table orders.order_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  order_id          uuid not null references orders.orders(id),
  menu_item_id      uuid not null,
  variant_id        uuid not null,
  item_name         text not null,
  variant_name      text not null,
  category_name     text not null,
  qty               int not null check (qty > 0),
  unit_price_minor  bigint not null check (unit_price_minor >= 0),
  modifiers         jsonb not null default '[]'::jsonb,
  line_total_minor  bigint not null check (line_total_minor >= 0)
);
create index order_lines_order_idx on orders.order_lines (order_id);

create table orders.refunds (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  org_id        uuid not null,
  location_id   uuid not null,
  order_id      uuid not null references orders.orders(id),
  amount_minor  bigint not null check (amount_minor > 0),
  reason        text not null check (length(trim(reason)) > 0),
  account_id    uuid not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by  uuid not null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);

create table orders.counters (
  tenant_id       uuid not null,
  business_day_id uuid primary key,
  next_no         int not null default 1
);

create table orders.outbox (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  type         text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  attempts     int not null default 0,
  last_error   text
);
create index outbox_pending_idx on orders.outbox (created_at) where processed_at is null;
