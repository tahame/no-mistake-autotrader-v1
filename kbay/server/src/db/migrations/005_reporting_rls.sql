-- 005_reporting_rls: reporting read model + tenant row-level security everywhere.

create schema if not exists reporting;

-- Sales facts, fed by the orders outbox (reporting never reads orders.* directly).
create table reporting.sales_lines (
  order_line_id   uuid primary key,
  tenant_id       uuid not null,
  org_id          uuid not null,
  location_id     uuid not null,
  business_day_id uuid not null,
  business_date   date not null,
  order_id        uuid not null,
  sold_at         timestamptz not null,
  sold_by         uuid not null,
  menu_item_id    uuid not null,
  variant_id      uuid not null,
  item_name       text not null,
  variant_name    text not null,
  category_name   text not null,
  qty             int not null,
  revenue_minor   bigint not null,
  voided          boolean not null default false
);
create index sales_lines_org_date_idx on reporting.sales_lines (org_id, business_date);

-- Row-level security: rows are visible only inside the current tenant
-- (set per transaction via app.tenant_id). Platform jobs set app.bypass_rls.
do $$
declare r record;
begin
  for r in
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.column_name = 'tenant_id'
      and t.table_type = 'BASE TABLE'
      and c.table_schema in ('core', 'catalog', 'inventory', 'orders', 'finance', 'reporting')
      and not (c.table_schema = 'core' and c.table_name in ('tenants', 'audit_log', 'users', 'sessions'))
  loop
    execute format('alter table %I.%I enable row level security', r.table_schema, r.table_name);
    execute format('alter table %I.%I force row level security', r.table_schema, r.table_name);
    execute format($p$create policy tenant_isolation on %I.%I
      using (current_setting('app.bypass_rls', true) = 'on'
             or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (current_setting('app.bypass_rls', true) = 'on'
             or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$,
      r.table_schema, r.table_name);
  end loop;
end $$;

-- users / sessions / audit_log have nullable tenant_id (platform owner) and are read
-- during login before a tenant is known; they are guarded in the identity module.
alter table core.users enable row level security;
alter table core.users force row level security;
create policy tenant_isolation on core.users
  using (current_setting('app.bypass_rls', true) = 'on'
         or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (current_setting('app.bypass_rls', true) = 'on'
         or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table core.audit_log enable row level security;
alter table core.audit_log force row level security;
create policy audit_read on core.audit_log for select
  using (current_setting('app.bypass_rls', true) = 'on'
         or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy audit_insert on core.audit_log for insert with check (true);
