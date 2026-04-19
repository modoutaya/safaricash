-- Story 1.3 — Migration 0008: reauth_challenges table + Vault HMAC key.
--
-- Creates the storage layer for the re-auth Edge Function:
--   - public.reauth_challenges: per-(collector, sensitive-op) OTP challenges
--   - HMAC-SHA256 key in vault.secrets (`reauth_otp_hmac_key`) used by the
--     Edge Function to hash OTPs at insert time and constant-time compare
--     at verify time. Raw OTPs are NEVER stored.
--   - audit_emit() trigger extended to fire on reauth_challenges with
--     status-aware event_type mappings (reauth.requested / verified /
--     failed / locked / expired).
--
-- See: architecture.md § Authentication & Security → Sensitive-op re-auth,
-- prd.md FR5 + NFR-S4, epics.md Story 1.3, ADR-001 § Search-on-encrypted
-- (this migration adds another secret to the Vault inventory).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.reauth_intended_op_enum as enum (
  'cycle_settlement',  -- consumed by Story 7.4
  'member_delete',     -- consumed by Story 2.6
  'csv_export',        -- consumed by Story 9.3
  'sms_resend'         -- consumed by Story 6.x receipt-resend
);

create type public.reauth_challenge_status_enum as enum (
  'pending',   -- OTP issued, awaiting verify
  'verified',  -- OTP matched; confirmation_token issued
  'failed',    -- one or two failed attempts (still verifiable)
  'locked',    -- 3 failed attempts → lockout window active
  'expired'    -- created_at + OTP_EXPIRY_MINUTES exceeded (cleanup-time terminal state)
);

-- ---------------------------------------------------------------------------
-- reauth_challenges table
-- ---------------------------------------------------------------------------

create table public.reauth_challenges (
  id                       uuid primary key default gen_random_uuid(),
  collector_id             uuid not null references public.users(id) on delete restrict,
  intended_op              public.reauth_intended_op_enum not null,
  -- HMAC-SHA256(otp, vault['reauth_otp_hmac_key']) — hex-encoded text.
  -- Raw OTP NEVER stored. The HMAC key is fetched per-request inside the
  -- Edge Function using SECURITY DEFINER vault_decrypt() (service-role only).
  otp_hash                 text not null check (otp_hash ~ '^[0-9a-f]{64}$'),
  attempts                 int not null default 0 check (attempts >= 0 and attempts <= 3),
  status                   public.reauth_challenge_status_enum not null default 'pending',
  -- Set when status transitions to 'locked' (3rd failed attempt).
  lockout_until            timestamptz,
  -- Issued on successful verify. Single-use (consumed atomically by
  -- _shared/reauth-check.ts in the consumer Edge Function).
  confirmation_token       uuid unique,
  confirmation_used        boolean not null default false,
  confirmation_expires_at  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- created_at + OTP_EXPIRY_MINUTES (set at insert time by the handler).
  expires_at               timestamptz not null,

  -- Invariants
  constraint reauth_challenges_lockout_consistency_chk check (
    (status = 'locked' and lockout_until is not null) or
    (status <> 'locked' and (lockout_until is null or lockout_until > created_at))
  ),
  constraint reauth_challenges_confirmation_consistency_chk check (
    (status = 'verified' and confirmation_token is not null and confirmation_expires_at is not null) or
    (status <> 'verified' and confirmation_token is null and confirmation_expires_at is null)
  ),
  constraint reauth_challenges_expires_after_created_chk check (expires_at > created_at)
);

comment on table public.reauth_challenges is
  'Per-(collector, sensitive-op) OTP challenges issued by the re-auth Edge Function (Story 1.3). Writes only via service_role; reads RLS-gated to the owning collector. Raw OTPs never stored — see otp_hash column.';

comment on column public.reauth_challenges.otp_hash is
  'HMAC-SHA256(otp, vault[reauth_otp_hmac_key]) hex-encoded. Constant-time compared at verify.';

comment on column public.reauth_challenges.confirmation_token is
  'Issued on successful verify. Consumer Edge Functions (Story 7.4 / 2.6 / 9.3 / 6.x) consume via _shared/reauth-check.ts atomic UPDATE-RETURNING.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Active-lockout lookup: WHERE collector_id = $ AND intended_op = $ ORDER BY created_at DESC LIMIT 1
create index idx_reauth_challenges_collector_id_intended_op_created_at
  on public.reauth_challenges (collector_id, intended_op, created_at desc);

-- Confirmation-token consumption (sparse — only set after verify success).
create unique index idx_reauth_challenges_confirmation_token
  on public.reauth_challenges (confirmation_token)
  where confirmation_token is not null;

-- ---------------------------------------------------------------------------
-- updated_at trigger (Story 1.2 helper)
-- ---------------------------------------------------------------------------

create trigger set_updated_at_reauth_challenges
  before update on public.reauth_challenges
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — collector SELECT only; writes are service_role only (Edge Function).
-- ---------------------------------------------------------------------------

alter table public.reauth_challenges enable row level security;
alter table public.reauth_challenges force row level security;

create policy reauth_challenges_collector_select
  on public.reauth_challenges
  as permissive
  for select
  to authenticated
  using (collector_id = auth.uid());

create policy reauth_challenges_no_anon
  on public.reauth_challenges
  for all to anon
  using (false)
  with check (false);

revoke insert, update, delete on public.reauth_challenges from anon;
revoke insert, update, delete on public.reauth_challenges from authenticated;
-- service_role retains via Postgres default — Edge Function uses service-role key.

-- ---------------------------------------------------------------------------
-- Vault HMAC key — provisioned once, idempotent.
-- ---------------------------------------------------------------------------

do $$
declare
  existing_id uuid;
begin
  select id into existing_id from vault.secrets where name = 'reauth_otp_hmac_key';
  if existing_id is null then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'reauth_otp_hmac_key',
      'HMAC-SHA256 key for OTP hashing in reauth_challenges (Story 1.3). Rotate per ADR-001.'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role-only RPC to fetch the HMAC key by canonical name. The Edge
-- Function calls this once per warm instance (cached) instead of querying
-- vault.decrypted_secrets directly (which PostgREST cannot expose).
-- ---------------------------------------------------------------------------

create or replace function public.get_reauth_otp_hmac_key()
returns text
language plpgsql
security definer
set search_path = vault, public, pg_temp
as $$
declare
  result text;
begin
  select decrypted_secret into result
  from vault.decrypted_secrets
  where name = 'reauth_otp_hmac_key';
  if result is null then
    raise exception 'reauth_otp_hmac_key vault secret not provisioned';
  end if;
  return result;
end;
$$;

comment on function public.get_reauth_otp_hmac_key() is
  'Returns the HMAC-SHA256 key used by the re-auth Edge Function (Story 1.3). Service-role-only — never grant to authenticated/anon.';

revoke execute on function public.get_reauth_otp_hmac_key() from public;
revoke execute on function public.get_reauth_otp_hmac_key() from authenticated;
revoke execute on function public.get_reauth_otp_hmac_key() from anon;
grant  execute on function public.get_reauth_otp_hmac_key() to service_role;

-- ---------------------------------------------------------------------------
-- audit_emit() trigger extension — adds reauth_challenges branches.
--
-- Adds 5 new event_type mappings:
--   INSERT (status=pending) → reauth.requested
--   UPDATE OLD.status<>'verified' AND NEW.status='verified' → reauth.verified
--   UPDATE OLD.status<>'locked' AND NEW.status='locked' → reauth.locked
--   UPDATE OLD.status<>'expired' AND NEW.status='expired' → reauth.expired
--   UPDATE NEW.attempts > OLD.attempts AND NEW.status='failed' (transient
--                                       1st/2nd attempt fail) → reauth.failed
--
-- The function preserves all Story 1.2 properties: clock_timestamp(),
-- per-collector pg_advisory_xact_lock(0x5AFA, hashtext(collector_id)),
-- canonical_jsonb(payload) for SQL ↔ TS hash parity.
-- ---------------------------------------------------------------------------

create or replace function public.audit_emit()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event_id     uuid;
  v_event_type   text;
  v_entity_id    uuid;
  v_entity_table text;
  v_timestamp    timestamptz;
  v_actor        text;
  v_source       text;
  v_payload      jsonb;
  v_collector_id uuid;
  v_op           text;
  v_prev_hash    bytea;
  v_entry_hash   bytea;
  v_delim        bytea := decode('1F', 'hex');
  v_serialized   bytea;
  v_iso_ts       text;
begin
  v_op           := tg_op;
  v_timestamp    := clock_timestamp();
  v_event_id     := gen_random_uuid();
  v_entity_table := tg_table_name::text;

  if v_op = 'DELETE' then
    v_collector_id := old.collector_id;
    v_entity_id    := old.id;
    v_payload      := to_jsonb(old);
  else
    v_collector_id := new.collector_id;
    v_entity_id    := new.id;
    v_payload      := to_jsonb(new);
  end if;

  -- event_type mapping per architecture.md § Event naming + Story 1.2 + 1.3.
  v_event_type := case
    when v_entity_table = 'members'      and v_op = 'INSERT' then 'member.created'
    when v_entity_table = 'members'      and v_op = 'UPDATE' then 'member.updated'
    when v_entity_table = 'members'      and v_op = 'DELETE' then 'member.deleted'
    when v_entity_table = 'cycles'       and v_op = 'INSERT' then 'cycle.started'
    when v_entity_table = 'cycles'       and v_op = 'UPDATE'
         and (v_payload->>'status') = 'settled'
         and (to_jsonb(old)->>'status') <> 'settled'   then 'cycle.settled'
    when v_entity_table = 'cycles'       and v_op = 'UPDATE' then 'cycle.updated'
    when v_entity_table = 'cycles'       and v_op = 'DELETE' then 'cycle.deleted'
    when v_entity_table = 'transactions' and v_op = 'INSERT' then 'transaction.committed'
    when v_entity_table = 'transactions' and v_op = 'UPDATE' then 'transaction.updated'
    when v_entity_table = 'transactions' and v_op = 'DELETE' then 'transaction.deleted'
    -- Story 1.3 reauth_challenges branches (UPDATE only — INSERT below).
    when v_entity_table = 'reauth_challenges' and v_op = 'INSERT' then 'reauth.requested'
    when v_entity_table = 'reauth_challenges' and v_op = 'UPDATE'
         and (v_payload->>'status') = 'verified'
         and (to_jsonb(old)->>'status') <> 'verified' then 'reauth.verified'
    when v_entity_table = 'reauth_challenges' and v_op = 'UPDATE'
         and (v_payload->>'status') = 'locked'
         and (to_jsonb(old)->>'status') <> 'locked' then 'reauth.locked'
    when v_entity_table = 'reauth_challenges' and v_op = 'UPDATE'
         and (v_payload->>'status') = 'expired'
         and (to_jsonb(old)->>'status') <> 'expired' then 'reauth.expired'
    when v_entity_table = 'reauth_challenges' and v_op = 'UPDATE'
         and (v_payload->>'status') = 'failed'
         and (v_payload->>'attempts')::int > (to_jsonb(old)->>'attempts')::int then 'reauth.failed'
    -- Confirmation-token consumption (collector_id same, status stays
    -- 'verified', confirmation_used flips false→true) is intentionally
    -- NOT a separate audit event here — the consumer story (7.4 / 2.6 /
    -- 9.3 / 6.x) emits its OWN domain audit event ('cycle.settled',
    -- 'member.deleted', etc.) which already chains the proof of re-auth
    -- via the audit log timestamp ordering.
    when v_entity_table = 'reauth_challenges' and v_op = 'UPDATE' then null  -- ignore
    else null
  end;

  if v_event_type is null then
    -- For reauth_challenges UPDATE that doesn't match a status transition
    -- (e.g., confirmation_used flip), silently skip emission.
    if v_entity_table = 'reauth_challenges' and v_op = 'UPDATE' then
      return new;
    end if;
    raise exception 'audit_emit: unmapped (table, op) = (%, %). Add a case branch and bump the audit-event taxonomy.', v_entity_table, v_op;
  end if;

  v_source := coalesce(current_setting('app.source', true), 'online');
  if v_source not in ('online', 'offline_reconciled') then
    v_source := 'online';
  end if;

  v_actor := coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), 'system');

  perform pg_advisory_xact_lock(0x5AFA, hashtext(v_collector_id::text));

  select entry_hash into v_prev_hash
  from public.audit_log
  where collector_id = v_collector_id
  order by timestamp desc, event_id desc
  limit 1;

  v_iso_ts := to_char(v_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  v_serialized :=
    coalesce(v_prev_hash, ''::bytea)              || v_delim ||
    convert_to(v_event_id::text, 'UTF8')          || v_delim ||
    convert_to(v_event_type, 'UTF8')              || v_delim ||
    convert_to(v_collector_id::text, 'UTF8')      || v_delim ||
    convert_to(v_entity_id::text, 'UTF8')         || v_delim ||
    convert_to(v_entity_table, 'UTF8')            || v_delim ||
    convert_to(v_iso_ts, 'UTF8')                  || v_delim ||
    convert_to(v_actor, 'UTF8')                   || v_delim ||
    convert_to(v_source, 'UTF8')                  || v_delim ||
    convert_to(public.canonical_jsonb(v_payload), 'UTF8');

  v_entry_hash := extensions.digest(v_serialized, 'sha256');

  insert into public.audit_log (
    event_id, event_type, collector_id, entity_id, entity_table,
    timestamp, actor, source, payload, prev_hash, entry_hash
  ) values (
    v_event_id, v_event_type, v_collector_id, v_entity_id, v_entity_table,
    v_timestamp, v_actor, v_source, v_payload, v_prev_hash, v_entry_hash
  );

  if v_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Attach trigger to reauth_challenges.
-- ---------------------------------------------------------------------------

create trigger audit_reauth_challenges
  after insert or update on public.reauth_challenges
  for each row execute function public.audit_emit();
