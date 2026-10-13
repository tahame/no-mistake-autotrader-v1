-- 001_core: tenancy, identity, roles, audit, approvals, comments, notifications.
-- Every tenant-owned table carries tenant_id and is protected by row-level security
-- (see 007_rls.sql). Money is always bigint minor units (paisa for PKR).

create schema if not exists core;

create table core.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  otp_enabled boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Per-tenant module switches (commercial packaging). Absent row = enabled.
create table core.tenant_modules (
  tenant_id uuid not null references core.tenants(id),
  module    text not null,
  enabled   boolean not null default true,
  primary key (tenant_id, module)
);

create table core.organizations (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references core.tenants(id),
  slug                 text not null,
  name                 text not null,
  brand_name           text not null,
  currency             text not null default 'PKR',
  currency_minor_units int  not null default 2,
  timezone             text not null default 'Asia/Karachi',
  settings             jsonb not null default '{}'::jsonb,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table core.locations (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references core.tenants(id),
  org_id                uuid not null references core.organizations(id),
  name                  text not null,
  kind                  text not null check (kind in ('stall', 'shop')),
  city                  text,
  address               text,
  approval_limit_minor  bigint not null default 200000 check (approval_limit_minor >= 0),
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  unique (org_id, name)
);

-- A person is known once per tenant; only the profile crosses organizations.
create table core.people (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id),
  full_name    text not null,
  display_name text,
  phone        text,
  email        text,
  cnic         text,
  address      text,
  notes        text,
  created_at   timestamptz not null default now()
);

create table core.person_orgs (
  tenant_id uuid not null references core.tenants(id),
  person_id uuid not null references core.people(id),
  org_id    uuid not null references core.organizations(id),
  primary key (person_id, org_id)
);

create table core.users (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid references core.tenants(id),
  person_id            uuid references core.people(id),
  username             text not null,
  password_hash        text not null,
  must_change_password boolean not null default true,
  totp_secret          text,
  totp_enabled         boolean not null default false,
  is_platform_owner    boolean not null default false,
  active               boolean not null default true,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now()
);
create unique index users_username_uq on core.users (lower(username));

create table core.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references core.users(id),
  tenant_id     uuid references core.tenants(id),
  token_hash    text not null unique,
  totp_passed   boolean not null default false,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);

-- Roles are sets of permissions; people hold roles. Nothing is hard-coded to a person.
create table core.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id),
  key         text not null,
  name        text not null,
  description text,
  permissions text[] not null default '{}',
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key)
);

-- Scope is chosen deliberately: all orgs, or a ticked set of orgs; optionally narrowed to locations.
create table core.role_assignments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id),
  user_id      uuid not null references core.users(id),
  role_id      uuid not null references core.roles(id),
  all_orgs     boolean not null default false,
  org_ids      uuid[] not null default '{}',
  location_ids uuid[] not null default '{}',
  granted_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  check (all_orgs or cardinality(org_ids) > 0)
);

-- Individual rights attached to or detached from a person (e.g. void/refund for one salesperson).
create table core.user_permission_overrides (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id),
  user_id    uuid not null references core.users(id),
  permission text not null,
  org_id     uuid references core.organizations(id),
  effect     text not null check (effect in ('grant', 'deny')),
  created_by uuid references core.users(id),
  created_at timestamptz not null default now()
);
create unique index user_perm_override_uq
  on core.user_permission_overrides (user_id, permission, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Append-only, hash-chained audit trail.
create table core.audit_log (
  id            bigserial primary key,
  tenant_id     uuid,
  org_id        uuid,
  actor_user_id uuid,
  action        text not null,
  entity_type   text not null,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  ip            text,
  at            timestamptz not null default clock_timestamp(),
  prev_hash     text,
  hash          text not null default ''
);
create index audit_log_entity_idx on core.audit_log (entity_type, entity_id);
create index audit_log_tenant_idx on core.audit_log (tenant_id, at desc);

-- Chain head lives in its own one-row table (no RLS), so every insert links to the previous one.
create table core.audit_head (id int primary key check (id = 1), hash text not null);
insert into core.audit_head (id, hash) values (1, 'genesis');

create or replace function core.audit_chain() returns trigger language plpgsql as $$
declare last_hash text;
begin
  select hash into last_hash from core.audit_head where id = 1 for update;
  new.prev_hash := last_hash;
  new.hash := encode(sha256(convert_to(
    new.prev_hash || '|' || coalesce(new.tenant_id::text, '') || '|' || coalesce(new.actor_user_id::text, '') || '|' ||
    new.action || '|' || new.entity_type || '|' || coalesce(new.entity_id, '') || '|' ||
    coalesce(new.before::text, '') || '|' || coalesce(new.after::text, '') || '|' || to_char(new.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex');
  update core.audit_head set hash = new.hash where id = 1;
  return new;
end $$;
create trigger audit_chain before insert on core.audit_log for each row execute function core.audit_chain();

create or replace function core.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'immutable_record: % on %.% is not allowed', tg_op, tg_table_schema, tg_table_name
    using errcode = 'P0001';
end $$;
create trigger audit_log_immutable before update or delete on core.audit_log
  for each row execute function core.forbid_change();

-- Approvals: anything of weight routes to a person holding the matching approve.* permission.
create table core.approval_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id),
  org_id        uuid not null references core.organizations(id),
  location_id   uuid references core.locations(id),
  kind          text not null,
  subject_type  text not null,
  subject_id    uuid not null,
  summary       text not null,
  amount_minor  bigint,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by  uuid not null references core.users(id),
  requested_at  timestamptz not null default now(),
  decided_by    uuid references core.users(id),
  decided_at    timestamptz,
  decision_note text,
  last_reminded_at timestamptz,
  reminder_count int not null default 0
);
create index approval_pending_idx on core.approval_requests (org_id, status);
create unique index approval_open_subject_uq on core.approval_requests (subject_type, subject_id) where status = 'pending';

-- Questions and notes attached to any entry (expense, sale, item, approval...).
create table core.comments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id),
  org_id        uuid not null references core.organizations(id),
  entity_type   text not null,
  entity_id     uuid not null,
  parent_id     uuid references core.comments(id),
  author_id     uuid not null references core.users(id),
  body          text not null,
  is_question   boolean not null default false,
  asked_user_id uuid references core.users(id),
  answered_at   timestamptz,
  last_followup_at timestamptz,
  created_at    timestamptz not null default now()
);
create index comments_entity_idx on core.comments (entity_type, entity_id);

create table core.notifications (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id),
  org_id     uuid references core.organizations(id),
  user_id    uuid not null references core.users(id),
  type       text not null,
  title      text not null,
  body       text not null default '',
  link       text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  pushed_at  timestamptz
);
create unique index notifications_dedupe_uq on core.notifications (user_id, dedupe_key) where dedupe_key is not null;
create index notifications_user_idx on core.notifications (user_id, created_at desc);

-- Org-level rule per notification type: on/off plus config (times, intervals).
create table core.notification_settings (
  tenant_id uuid not null references core.tenants(id),
  org_id    uuid not null references core.organizations(id),
  type      text not null,
  enabled   boolean not null default true,
  config    jsonb not null default '{}'::jsonb,
  primary key (org_id, type)
);

-- Per-person opt-out. Absent row = on.
create table core.user_notification_prefs (
  tenant_id uuid not null references core.tenants(id),
  user_id   uuid not null references core.users(id),
  type      text not null,
  enabled   boolean not null,
  primary key (user_id, type)
);

create table core.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id),
  user_id    uuid not null references core.users(id),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- Idempotency for event handlers (orders outbox consumers).
create table core.event_handled (
  event_id   uuid not null,
  handler    text not null,
  handled_at timestamptz not null default now(),
  primary key (event_id, handler)
);

-- Platform-level settings for the owner portal (SMS/email provider etc. later).
create table core.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
