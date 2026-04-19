-- Story 1.2 — Migration 0001: initial schema for SafariCash MVP.
--
-- Tables: users, members, cycles, transactions, sms_queue, disputes, audit_log.
-- The audit_log SHAPE only is created here; its trigger is added in 0007.
-- RLS, Vault encryption, performance indexes, and audit triggers come in
-- their own dedicated migrations (0002, 0005, 0006, 0007).
--
-- Naming: snake_case plural tables, {referenced_singular}_id FKs,
-- {table}_{field}_enum enums, idx_{table}_{columns} indexes, created_at /
-- updated_at timestamptz with BEFORE UPDATE triggers.
--
-- See: architecture.md § Data Architecture, § Implementation Patterns.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- gen_random_uuid()
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Shared trigger: BEFORE UPDATE → bump updated_at
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Generic BEFORE UPDATE trigger function: sets NEW.updated_at = now(). Attached per-table below.';

-- ---------------------------------------------------------------------------
-- Enums (one per {table}_{field} per architecture naming convention)
-- ---------------------------------------------------------------------------

create type public.users_role_enum as enum ('collector', 'super_admin');

create type public.members_status_enum as enum ('active', 'paused', 'completed', 'deleted');

create type public.cycles_status_enum as enum ('active', 'with_advance', 'completed', 'settled');

create type public.transactions_kind_enum as enum ('contribution', 'rattrapage', 'advance');

create type public.transactions_source_enum as enum ('online', 'offline_reconciled');

create type public.sms_queue_status_enum as enum ('queued', 'sent', 'delivered', 'failed', 'abandoned');

create type public.disputes_via_enum as enum ('receipt_url', 'support_email', 'support_phone');

create type public.disputes_status_enum as enum ('open', 'resolved', 'dismissed');

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

create table public.users (
  id           uuid primary key references auth.users(id) on delete restrict,
  phone_number text not null unique,
  role         public.users_role_enum not null default 'collector',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.users is
  'Collector accounts. id = auth.users(id). Pre-provisioned via Supabase Studio at MVP (architecture.md § Admin Provisioning Tool).';

create trigger set_updated_at_users
  before update on public.users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- members
-- ---------------------------------------------------------------------------

create table public.members (
  id            uuid primary key default gen_random_uuid(),
  collector_id  uuid not null references public.users(id) on delete restrict,
  -- name and phone_number are wrapped by Supabase Vault in migration 0005.
  name          text not null,
  phone_number  text not null,
  daily_amount  numeric(12, 0) not null check (daily_amount > 0),
  status        public.members_status_enum not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.members is
  'Tontine savers managed by a collector. name + phone_number are Vault-encrypted (see 0005).';

create trigger set_updated_at_members
  before update on public.members
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- cycles
-- ---------------------------------------------------------------------------

create table public.cycles (
  id            uuid primary key default gen_random_uuid(),
  collector_id  uuid not null references public.users(id) on delete restrict,
  member_id     uuid not null references public.members(id) on delete restrict,
  cycle_number  int not null check (cycle_number >= 1),
  start_date    date not null,
  end_date      date not null,
  status        public.cycles_status_enum not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint cycles_member_id_cycle_number_key unique (member_id, cycle_number),
  constraint cycles_dates_chk check (end_date >= start_date)
);

comment on table public.cycles is
  '30-day tontine cycle per member. cycle_number monotonically increases per member starting at 1.';

create trigger set_updated_at_cycles
  before update on public.cycles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------

create table public.transactions (
  id            uuid primary key default gen_random_uuid(),
  collector_id  uuid not null references public.users(id) on delete restrict,
  member_id     uuid not null references public.members(id) on delete restrict,
  cycle_id      uuid not null references public.cycles(id) on delete restrict,
  kind          public.transactions_kind_enum not null,
  -- amount is wrapped by Supabase Vault in migration 0005.
  amount        numeric(12, 0) not null check (amount > 0),
  cycle_day     int not null check (cycle_day between 1 and 30),
  source        public.transactions_source_enum not null default 'online',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.transactions is
  'Per-day contribution / rattrapage / advance transactions. amount is Vault-encrypted (see 0005).';

create trigger set_updated_at_transactions
  before update on public.transactions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- sms_queue
-- ---------------------------------------------------------------------------

create table public.sms_queue (
  id              uuid primary key default gen_random_uuid(),
  collector_id    uuid not null references public.users(id) on delete restrict,
  transaction_id  uuid references public.transactions(id) on delete cascade,
  -- recipient_phone is encrypted upstream (the saver's number is also stored
  -- encrypted on members.phone_number via Vault); duplicated here for the
  -- worker drain query so it does not need to re-decrypt members on each pass.
  recipient_phone text not null,
  body            text not null,
  status          public.sms_queue_status_enum not null default 'queued',
  attempts        int not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now()
);

comment on table public.sms_queue is
  'Durable SMS commitment queue. Owned by Story 6.1 (sms-dispatch) and Story 6.2 (sms-worker drain via Termii).';

-- Worker drain query: WHERE status = 'queued' ORDER BY created_at ASC.
create index idx_sms_queue_status_created_at on public.sms_queue (status, created_at);

-- ---------------------------------------------------------------------------
-- disputes
-- ---------------------------------------------------------------------------

create table public.disputes (
  id              uuid primary key default gen_random_uuid(),
  collector_id    uuid not null references public.users(id) on delete restrict,
  transaction_id  uuid not null references public.transactions(id) on delete restrict,
  flagged_at      timestamptz not null default now(),
  flagged_via     public.disputes_via_enum not null default 'receipt_url',
  status          public.disputes_status_enum not null default 'open',
  notes           text,
  resolved_at     timestamptz
);

comment on table public.disputes is
  'Saver-flagged transaction disputes. Owned by Epic 10 (dispute flow + saver data rights).';

-- ---------------------------------------------------------------------------
-- audit_log (table shape only; trigger lives in 0007)
-- ---------------------------------------------------------------------------

create table public.audit_log (
  event_id     uuid primary key default gen_random_uuid(),
  event_type   text not null,
  collector_id uuid not null references public.users(id) on delete restrict,
  entity_id    uuid not null,
  entity_table text not null,
  timestamp    timestamptz not null default now(),
  actor        text not null,
  source       text not null check (source in ('online', 'offline_reconciled')),
  payload      jsonb not null,
  prev_hash    bytea,
  entry_hash   bytea not null
);

comment on table public.audit_log is
  'Hash-chained, append-only audit trail (NFR-S6). One chain per collector_id. Writes only via the SECURITY DEFINER trigger in 0007.';
