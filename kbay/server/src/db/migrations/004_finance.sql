-- 004_finance: double-entry ledger, money accounts, business days (open/close),
-- expenses, purchases, suppliers and credit, capital (investment, loans, withdrawals),
-- partners, investors, employees and labour.

create schema if not exists finance;

-- Chart of accounts (account heads). system_key marks heads the code posts to.
create table finance.ledger_accounts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id),
  org_id     uuid not null references core.organizations(id),
  code       text not null,
  name       text not null,
  type       text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  system_key text,
  is_expense_category boolean not null default false,
  active     boolean not null default true,
  unique (org_id, code),
  unique (org_id, system_key)
);

-- Real accounts money sits in: cash in hand, wallets, banks — each owned by a named person.
create table finance.money_accounts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id),
  org_id            uuid not null references core.organizations(id),
  location_id       uuid references core.locations(id),
  name              text not null,
  kind              text not null check (kind in ('cash', 'easypaisa', 'jazzcash', 'nayapay', 'sadapay', 'bank', 'other')),
  owner_person_id   uuid references core.people(id),
  ledger_account_id uuid not null references finance.ledger_accounts(id),
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (org_id, name)
);

create table finance.suppliers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id),
  org_id     uuid not null references core.organizations(id),
  name       text not null,
  phone      text,
  notes      text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

-- A business day runs from opening to close (stalls open ~3-5pm and may close after midnight),
-- so it is a session, not a calendar day. Approval locks it.
create table finance.business_days (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references core.tenants(id),
  org_id              uuid not null references core.organizations(id),
  location_id         uuid not null references core.locations(id),
  business_date       date not null,
  status              text not null default 'open' check (status in ('open', 'submitted', 'approved')),
  opening_float_minor bigint not null check (opening_float_minor >= 0),
  float_account_id    uuid not null references finance.money_accounts(id),
  opening_note        text,
  opened_by           uuid not null references core.users(id),
  opened_at           timestamptz not null default now(),
  closing_note        text,
  submitted_by        uuid references core.users(id),
  submitted_at        timestamptz,
  approved_by         uuid references core.users(id),
  approved_at         timestamptz,
  unique (location_id, business_date)
);
create unique index one_open_day_per_location on finance.business_days (location_id) where status = 'open';

-- At close: what the system expects in each account vs what was counted / declared.
create table finance.day_close_lines (
  tenant_id        uuid not null references core.tenants(id),
  business_day_id  uuid not null references finance.business_days(id),
  money_account_id uuid not null references finance.money_accounts(id),
  expected_minor   bigint not null,
  declared_minor   bigint not null,
  primary key (business_day_id, money_account_id)
);

create table finance.journal_entries (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id),
  org_id           uuid not null references core.organizations(id),
  location_id      uuid references core.locations(id),
  business_day_id  uuid references finance.business_days(id),
  entry_date       date not null,
  memo             text not null,
  source_type      text not null,
  source_id        uuid,
  reverses_entry_id uuid references finance.journal_entries(id),
  created_by       uuid,
  created_at       timestamptz not null default now()
);
create index journal_entries_org_date_idx on finance.journal_entries (org_id, entry_date);
create index journal_entries_source_idx on finance.journal_entries (source_type, source_id);

create table finance.journal_lines (
  id                bigserial primary key,
  tenant_id         uuid not null references core.tenants(id),
  entry_id          uuid not null references finance.journal_entries(id),
  ledger_account_id uuid not null references finance.ledger_accounts(id),
  debit_minor       bigint not null default 0 check (debit_minor >= 0),
  credit_minor      bigint not null default 0 check (credit_minor >= 0),
  location_id       uuid references core.locations(id),
  money_account_id  uuid references finance.money_accounts(id),
  person_id         uuid references core.people(id),
  supplier_id       uuid references finance.suppliers(id),
  memo              text,
  check ((debit_minor = 0) <> (credit_minor = 0))
);
create index journal_lines_entry_idx on finance.journal_lines (entry_id);
create index journal_lines_account_idx on finance.journal_lines (ledger_account_id);

-- Every entry must balance (sum debits = sum credits) and have at least two lines. Checked at commit.
create or replace function finance.check_entry_balanced() returns trigger language plpgsql as $$
declare d bigint; c bigint; n int; eid uuid;
begin
  eid := new.entry_id;
  select coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0), count(*)
    into d, c, n from finance.journal_lines where entry_id = eid;
  if n < 2 or d <> c then
    raise exception 'unbalanced_journal_entry: entry % has % lines, debits %, credits %', eid, n, d, c
      using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger journal_lines_balanced after insert on finance.journal_lines
  deferrable initially deferred for each row execute function finance.check_entry_balanced();

create or replace function finance.check_entry_has_lines() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from finance.journal_lines where entry_id = new.id) then
    raise exception 'empty_journal_entry: entry % has no lines', new.id using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger journal_entry_has_lines after insert on finance.journal_entries
  deferrable initially deferred for each row execute function finance.check_entry_has_lines();

create trigger journal_entries_immutable before update or delete on finance.journal_entries
  for each row execute function core.forbid_change();
create trigger journal_lines_immutable before update or delete on finance.journal_lines
  for each row execute function core.forbid_change();

-- A locked (approved) day accepts no new postings: corrections go into a later open day.
create or replace function finance.forbid_posting_to_locked_day() returns trigger language plpgsql as $$
begin
  if new.business_day_id is not null and exists (
    select 1 from finance.business_days where id = new.business_day_id and status = 'approved') then
    raise exception 'day_locked: business day % is approved and locked', new.business_day_id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger journal_entries_day_lock before insert on finance.journal_entries
  for each row execute function finance.forbid_posting_to_locked_day();

create table finance.expenses (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references core.tenants(id),
  org_id              uuid not null references core.organizations(id),
  location_id         uuid references core.locations(id),
  business_day_id     uuid references finance.business_days(id),
  category_account_id uuid not null references finance.ledger_accounts(id),
  amount_minor        bigint not null check (amount_minor > 0),
  payment             text not null check (payment in ('paid', 'credit')),
  money_account_id    uuid references finance.money_accounts(id),
  supplier_id         uuid references finance.suppliers(id),
  payee               text,
  description         text not null,
  status              text not null check (status in ('pending_approval', 'posted', 'rejected')),
  approval_id         uuid references core.approval_requests(id),
  journal_entry_id    uuid references finance.journal_entries(id),
  created_by          uuid not null references core.users(id),
  created_at          timestamptz not null default now(),
  check (payment <> 'paid' or money_account_id is not null),
  check (payment <> 'credit' or supplier_id is not null)
);

create table finance.purchases (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id),
  org_id           uuid not null references core.organizations(id),
  location_id      uuid not null references core.locations(id),
  business_day_id  uuid references finance.business_days(id),
  supplier_id      uuid not null references finance.suppliers(id),
  payment          text not null check (payment in ('paid', 'credit')),
  money_account_id uuid references finance.money_accounts(id),
  total_minor      bigint not null check (total_minor > 0),
  note             text,
  status           text not null check (status in ('pending_approval', 'posted', 'rejected')),
  approval_id      uuid references core.approval_requests(id),
  journal_entry_id uuid references finance.journal_entries(id),
  created_by       uuid not null references core.users(id),
  created_at       timestamptz not null default now(),
  check (payment <> 'paid' or money_account_id is not null)
);

create table finance.purchase_lines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id),
  purchase_id uuid not null references finance.purchases(id),
  item_id     uuid not null references inventory.items(id),
  qty         numeric(18, 3) not null check (qty > 0),
  unit        text not null references catalog.units(code),
  qty_base    numeric(18, 3) not null check (qty_base > 0),
  total_minor bigint not null check (total_minor > 0)
);
create index purchase_lines_item_idx on finance.purchase_lines (item_id);

create table finance.supplier_payments (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id),
  org_id           uuid not null references core.organizations(id),
  location_id      uuid references core.locations(id),
  supplier_id      uuid not null references finance.suppliers(id),
  amount_minor     bigint not null check (amount_minor > 0),
  money_account_id uuid not null references finance.money_accounts(id),
  note             text,
  journal_entry_id uuid references finance.journal_entries(id),
  created_by       uuid not null references core.users(id),
  created_at       timestamptz not null default now()
);

-- Partner profit share as a weight (ratio). Percent = weight / sum(weights) on that date.
-- History is kept: a change closes the old row (effective_to) and opens a new one.
create table finance.partner_shares (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id),
  org_id         uuid not null references core.organizations(id),
  person_id      uuid not null references core.people(id),
  weight         numeric(12, 6) not null check (weight > 0),
  effective_from date not null,
  effective_to   date,
  created_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

-- Investor terms per organization: return optional, mentorship optional; history kept.
create table finance.investor_terms (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id),
  org_id         uuid not null references core.organizations(id),
  person_id      uuid not null references core.people(id),
  takes_return   boolean not null default false,
  return_weight  numeric(12, 6) not null default 0 check (return_weight >= 0),
  mentorship     boolean not null default false,
  effective_from date not null,
  effective_to   date,
  created_by     uuid references core.users(id),
  created_at     timestamptz not null default now()
);

create table finance.loans (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id),
  org_id          uuid not null references core.organizations(id),
  location_id     uuid references core.locations(id),
  person_id       uuid not null references core.people(id),
  principal_minor bigint not null check (principal_minor > 0),
  due_date        date,
  note            text,
  status          text not null default 'open' check (status in ('open', 'closed')),
  created_by      uuid not null references core.users(id),
  created_at      timestamptz not null default now()
);

-- Every capital movement. Withdrawals and loan refunds route through approval;
-- a loan refund is only posted once the lender confirms receipt.
create table finance.capital_txns (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id),
  org_id           uuid not null references core.organizations(id),
  location_id      uuid references core.locations(id),
  person_id        uuid not null references core.people(id),
  kind             text not null check (kind in ('investment', 'loan_in', 'loan_convert', 'loan_refund',
                                                  'withdrawal', 'reinvest', 'advance', 'advance_repay')),
  amount_minor     bigint not null check (amount_minor > 0),
  money_account_id uuid references finance.money_accounts(id),
  loan_id          uuid references finance.loans(id),
  reason           text,
  status           text not null check (status in ('pending_approval', 'awaiting_confirmation', 'posted', 'rejected')),
  approval_id      uuid references core.approval_requests(id),
  journal_entry_id uuid references finance.journal_entries(id),
  created_by       uuid not null references core.users(id),
  created_at       timestamptz not null default now(),
  confirmed_by     uuid references core.users(id),
  confirmed_at     timestamptz
);
create index capital_person_idx on finance.capital_txns (org_id, person_id);

create table finance.employees (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenants(id),
  org_id             uuid not null references core.organizations(id),
  person_id          uuid not null references core.people(id),
  location_id        uuid references core.locations(id),
  title              text not null,
  pay_type           text not null check (pay_type in ('monthly', 'daily', 'hourly', 'none')),
  pay_rate_minor     bigint not null default 0 check (pay_rate_minor >= 0),
  commission_enabled boolean not null default false,
  commission_bps     int not null default 0 check (commission_bps between 0 and 10000),
  active             boolean not null default true,
  started_on         date,
  ended_on           date,
  created_at         timestamptz not null default now(),
  unique (org_id, person_id)
);

create table finance.commission_accruals (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id),
  org_id           uuid not null references core.organizations(id),
  business_day_id  uuid not null references finance.business_days(id),
  employee_id      uuid not null references finance.employees(id),
  sales_minor      bigint not null,
  commission_bps   int not null,
  amount_minor     bigint not null,
  journal_entry_id uuid references finance.journal_entries(id),
  unique (business_day_id, employee_id)
);

create table finance.wage_payments (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id),
  org_id           uuid not null references core.organizations(id),
  location_id      uuid references core.locations(id),
  business_day_id  uuid references finance.business_days(id),
  employee_id      uuid not null references finance.employees(id),
  period_from      date,
  period_to        date,
  units            numeric(12, 3) not null default 0,
  base_minor       bigint not null default 0 check (base_minor >= 0),
  commission_minor bigint not null default 0 check (commission_minor >= 0),
  total_minor      bigint not null check (total_minor > 0),
  money_account_id uuid not null references finance.money_accounts(id),
  note             text,
  journal_entry_id uuid references finance.journal_entries(id),
  created_by       uuid not null references core.users(id),
  created_at       timestamptz not null default now()
);

-- Adding a partner or changing shares is proposed, approved, then applied with history kept.
create table finance.partner_share_proposals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id),
  org_id         uuid not null references core.organizations(id),
  shares         jsonb not null,
  effective_from date not null,
  reason         text,
  status         text not null default 'pending_approval' check (status in ('pending_approval', 'applied', 'rejected')),
  approval_id    uuid references core.approval_requests(id),
  created_by     uuid not null references core.users(id),
  created_at     timestamptz not null default now()
);
