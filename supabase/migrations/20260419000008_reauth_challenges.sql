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

-- Idempotency wrappers — code review M5 fix. CREATE TYPE/TABLE/POLICY/INDEX
-- without IF NOT EXISTS would error on re-apply via `supabase db push`. The
-- DO blocks make the migration safe to re-run on a project already at 0008.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'reauth_intended_op_enum') then
    create type public.reauth_intended_op_enum as enum (
      'cycle_settlement',  -- consumed by Story 7.4
      'member_delete',     -- consumed by Story 2.6
      'csv_export',        -- consumed by Story 9.3
      'sms_resend'         -- consumed by Story 6.x receipt-resend
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'reauth_challenge_status_enum') then
    create type public.reauth_challenge_status_enum as enum (
      'pending',   -- OTP issued, awaiting verify
      'verified',  -- OTP matched; confirmation_token issued
      'failed',    -- one or two failed attempts (still verifiable)
      'locked',    -- 3 failed attempts → lockout window active
      'expired'    -- terminal — created_at+OTP_EXPIRY_MINUTES exceeded OR Termii dispatch failed
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- reauth_challenges table
-- ---------------------------------------------------------------------------

create table if not exists public.reauth_challenges (
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
create index if not exists idx_reauth_challenges_collector_id_intended_op_created_at
  on public.reauth_challenges (collector_id, intended_op, created_at desc);

-- Confirmation-token consumption (sparse — only set after verify success).
create unique index if not exists idx_reauth_challenges_confirmation_token
  on public.reauth_challenges (confirmation_token)
  where confirmation_token is not null;

-- CRITICAL race fix (code review C2): UNIQUE constraint on (collector_id,
-- intended_op) WHERE status='pending' prevents two parallel issue calls
-- both passing the resend-cooldown pre-check and both INSERTing rows.
-- The handler catches Postgres error code 23505 (unique violation) and
-- returns otp_resend_too_soon (429) instead of internal_unexpected.
create unique index if not exists idx_reauth_challenges_one_pending_per_op
  on public.reauth_challenges (collector_id, intended_op)
  where status = 'pending';

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
-- pg_temp only — force every identifier in the body to be fully qualified
-- (defense in depth against search-path shadowing of vault.* via attacker-
-- created public objects).
set search_path = pg_temp
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
-- Atomic state-transition RPCs (CRITICAL race fixes from code review).
--
-- The Edge Function calls these instead of doing read-modify-write on the
-- row, which had a race window allowing concurrent verifies to ALL read
-- attempts=0 and ALL write attempts=1 — defeating the lockout entirely.
-- Each function is a single SQL statement guarded by Postgres row locks
-- (UPDATE ... WHERE ... RETURNING) — atomic by construction.
-- All three are SECURITY DEFINER, service_role-only.
-- ---------------------------------------------------------------------------

-- Result type for reauth_record_failed_verify.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'reauth_verify_outcome') then
    create type public.reauth_verify_outcome as (
      attempts        int,
      status          public.reauth_challenge_status_enum,
      lockout_until   timestamptz
    );
  end if;
end;
$$;

-- ATOMIC CAS: increment attempts; if attempts reaches OTP_MAX_ATTEMPTS=3
-- transition to 'locked' with lockout_until = now() + 5 min; otherwise
-- transition (or stay at) 'failed'. Returns the resulting state.
-- Returns NULL if challenge does not exist or is in a terminal state
-- (verified / locked / expired) — handler treats NULL as otp_already_used.
create or replace function public.reauth_record_failed_verify(
  p_challenge_id uuid,
  p_collector_id uuid
)
returns public.reauth_verify_outcome
language plpgsql
security definer
set search_path = pg_temp
as $$
declare
  result public.reauth_verify_outcome;
  lockout_seconds int := 5 * 60;
  max_attempts int := 3;
begin
  update public.reauth_challenges
    set attempts = attempts + 1,
        status = case
          when attempts + 1 >= max_attempts then 'locked'::public.reauth_challenge_status_enum
          else 'failed'::public.reauth_challenge_status_enum
        end,
        lockout_until = case
          when attempts + 1 >= max_attempts then clock_timestamp() + (lockout_seconds || ' seconds')::interval
          else lockout_until
        end
    where id = p_challenge_id
      and collector_id = p_collector_id
      and status in ('pending', 'failed')
      and expires_at > clock_timestamp()
    returning attempts, status, lockout_until
    into result;
  return result;
end;
$$;

comment on function public.reauth_record_failed_verify(uuid, uuid) is
  'Atomic CAS for failed verify. Increments attempts; transitions to locked at OTP_MAX_ATTEMPTS=3. Returns NULL on already-terminal/expired/cross-collector. Service-role only.';

revoke execute on function public.reauth_record_failed_verify(uuid, uuid) from public;
revoke execute on function public.reauth_record_failed_verify(uuid, uuid) from authenticated;
revoke execute on function public.reauth_record_failed_verify(uuid, uuid) from anon;
grant  execute on function public.reauth_record_failed_verify(uuid, uuid) to service_role;

-- Result type for reauth_mark_verified.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'reauth_mark_verified_result') then
    create type public.reauth_mark_verified_result as (
      confirmation_token       uuid,
      confirmation_expires_at  timestamptz
    );
  end if;
end;
$$;

-- ATOMIC CAS: transition status pending|failed → verified, mint a fresh
-- confirmation_token (uuid v4) and set confirmation_expires_at = now() + 2 min.
-- Returns NULL if the challenge is already in a terminal state — handler
-- treats NULL as otp_already_used.
create or replace function public.reauth_mark_verified(
  p_challenge_id uuid,
  p_collector_id uuid
)
returns public.reauth_mark_verified_result
language plpgsql
security definer
set search_path = pg_temp
as $$
declare
  result public.reauth_mark_verified_result;
  confirmation_seconds int := 2 * 60;
  new_token uuid := extensions.gen_random_uuid();
begin
  update public.reauth_challenges
    set status = 'verified',
        confirmation_token = new_token,
        confirmation_expires_at = clock_timestamp() + (confirmation_seconds || ' seconds')::interval
    where id = p_challenge_id
      and collector_id = p_collector_id
      and status in ('pending', 'failed')
      and expires_at > clock_timestamp()
    returning confirmation_token, confirmation_expires_at
    into result;
  return result;
end;
$$;

comment on function public.reauth_mark_verified(uuid, uuid) is
  'Atomic CAS for successful verify. Transitions to verified + mints confirmation_token. Returns NULL on already-terminal/expired/cross-collector. Service-role only.';

revoke execute on function public.reauth_mark_verified(uuid, uuid) from public;
revoke execute on function public.reauth_mark_verified(uuid, uuid) from authenticated;
revoke execute on function public.reauth_mark_verified(uuid, uuid) from anon;
grant  execute on function public.reauth_mark_verified(uuid, uuid) to service_role;

-- ATOMIC CAS for confirmation_token consumption (replaces the JS-clock
-- check in _shared/reauth-check.ts, fixing the clock-skew bypass H8).
-- All four conditions checked + flip to confirmation_used=true in a single
-- statement. Returns true on success, false on any failure mode (token
-- not found / wrong collector / wrong intended_op / expired / already used).
-- The deliberately-generic boolean prevents an oracle for distinguishing
-- failure reasons (matches the spec's "single confirmation/invalid problem").
create or replace function public.reauth_consume_confirmation(
  p_token        uuid,
  p_collector_id uuid,
  p_intended_op  public.reauth_intended_op_enum
)
returns boolean
language plpgsql
security definer
set search_path = pg_temp
as $$
declare
  consumed_id uuid;
begin
  update public.reauth_challenges
    set confirmation_used = true
    where confirmation_token = p_token
      and collector_id = p_collector_id
      and intended_op = p_intended_op
      and confirmation_used = false
      and confirmation_expires_at > clock_timestamp()
    returning id into consumed_id;
  return consumed_id is not null;
end;
$$;

comment on function public.reauth_consume_confirmation(uuid, uuid, public.reauth_intended_op_enum) is
  'Atomic single-use confirmation token consumption. Replaces JS-clock checks (clock-skew bypass fix). Service-role only — Story 7.4/2.6/9.3/6.x consumer Edge Functions invoke via _shared/reauth-check.ts.';

revoke execute on function public.reauth_consume_confirmation(uuid, uuid, public.reauth_intended_op_enum) from public;
revoke execute on function public.reauth_consume_confirmation(uuid, uuid, public.reauth_intended_op_enum) from authenticated;
revoke execute on function public.reauth_consume_confirmation(uuid, uuid, public.reauth_intended_op_enum) from anon;
grant  execute on function public.reauth_consume_confirmation(uuid, uuid, public.reauth_intended_op_enum) to service_role;

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

  -- Redact otp_hash from reauth_challenges audit payloads (code review H7).
  -- An attacker who later compromises the HMAC key + has read access to
  -- audit_log could brute-force the 10^6 OTP space against historical
  -- otp_hash values. Removing it from the persisted payload eliminates
  -- this 5-min-window leak retroactively. The hash is still computed into
  -- the chain via canonical_jsonb (without the field), so chain integrity
  -- is preserved.
  if v_entity_table = 'reauth_challenges' and v_payload ? 'otp_hash' then
    v_payload := v_payload - 'otp_hash';
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
    -- Confirmation-token consumption (status='verified', confirmation_used
    -- flips false→true). Code review M2: emit a reauth.consumed event so
    -- the audit chain explicitly links re-auth to the downstream domain
    -- event (cycle.settled / member.deleted / csv.exported / sms.resent).
    when v_entity_table = 'reauth_challenges' and v_op = 'UPDATE'
         and (v_payload->>'confirmation_used')::boolean = true
         and (to_jsonb(old)->>'confirmation_used')::boolean = false then 'reauth.consumed'
    when v_entity_table = 'reauth_challenges' and v_op = 'UPDATE' then null  -- ignore other UPDATEs
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
