-- Story 2.3 — Migration 0015: per-collector phone uniqueness via salted hash.
--
-- Story 2.2 deferred phone-uniqueness ("no constraint at MVP — add when
-- duplicates are observed"). Story 2.3 (bulk-import via device contacts)
-- surfaces the duplicate problem more visibly: a careless collector can
-- re-import their entire contact book twice. Per the spec's Q4 review pass,
-- we add a real DB unique constraint instead of accepting the risk.
--
-- THE TRAP: vault_encrypt(plaintext) returns a fresh secret_id (uuid) on
-- every call, even for identical plaintext — so a unique constraint on
-- `phone_number_encrypted` would catch nothing. We need a deterministic
-- fingerprint of the plaintext to constrain on.
--
-- SOLUTION: a `phone_number_hash` column = sha256(collector_id || ':' ||
-- trimmed_phone), salted per-collector so a leak of one collector's hashes
-- cannot be cross-referenced against another collector's saver list.
-- Empty phones are stored as NULL (not the hash of '') so the partial
-- unique index ignores them — multiple cash-only savers per collector
-- remain valid (a real-world need at MVP scale).
--
-- See: _bmad-output/implementation-artifacts/2-3-contacts-bulk-import.md
-- AC #10 + Task 0.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. Column.
-- ---------------------------------------------------------------------------

alter table public.members
  add column if not exists phone_number_hash text;

comment on column public.members.phone_number_hash is
  'sha256(collector_id || '':'' || trimmed_phone). Empty phone → NULL (excluded from the unique index). Per-collector salt prevents cross-collector enumeration.';

-- ---------------------------------------------------------------------------
-- 2. Backfill existing rows from the decrypted view. Empty phones stay NULL.
--    members_decrypted is security_invoker — at migration time we run as
--    postgres so it sees everything.
-- ---------------------------------------------------------------------------

update public.members m
set phone_number_hash = encode(
  extensions.digest(m.collector_id::text || ':' || md.phone_number, 'sha256'),
  'hex'
)
from public.members_decrypted md
where m.id = md.id
  and nullif(trim(md.phone_number), '') is not null;

-- ---------------------------------------------------------------------------
-- 3. Partial unique index — non-null phones only.
-- ---------------------------------------------------------------------------

create unique index if not exists idx_members_collector_phone_unique
  on public.members (collector_id, phone_number_hash)
  where phone_number_hash is not null;

comment on index public.idx_members_collector_phone_unique is
  'Per-collector phone uniqueness via salted hash. Empty/null phones excluded so multiple cash-only savers remain valid.';

-- ---------------------------------------------------------------------------
-- 4. CREATE OR REPLACE create_member_with_cycle to compute + insert the hash.
--    Same signature as Story 2.2 migration 0014.
-- ---------------------------------------------------------------------------

create or replace function public.create_member_with_cycle(
  p_name         text,
  p_phone_number text,
  p_daily_amount integer,
  p_created_via  public.members_created_via_enum default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id  uuid;
  v_name_secret   uuid;
  v_phone_secret  uuid;
  v_phone_clean   text;
  v_phone_hash    text;
  v_member_id     uuid;
  v_today         date := current_date;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  if p_name is null or length(trim(p_name)) < 2 then
    raise exception 'invalid_name: must be at least 2 characters after trim' using errcode = '22000';
  end if;
  if length(trim(p_name)) > 80 then
    raise exception 'invalid_name: must be at most 80 characters' using errcode = '22000';
  end if;
  if p_daily_amount is null or p_daily_amount <= 0 then
    raise exception 'invalid_amount: daily_amount must be positive' using errcode = '22000';
  end if;
  if p_daily_amount > 100000 then
    raise exception 'invalid_amount: daily_amount must be at most 100000 FCFA' using errcode = '22000';
  end if;

  v_phone_clean := coalesce(trim(p_phone_number), '');

  v_name_secret  := public.vault_encrypt(trim(p_name));
  v_phone_secret := public.vault_encrypt(v_phone_clean);

  -- Story 2.3 — compute the dedup hash. Empty phone → NULL so the partial
  -- unique index ignores it (multiple cash-only savers per collector OK).
  v_phone_hash := case
    when v_phone_clean = '' then null
    else encode(
      extensions.digest(v_collector_id::text || ':' || v_phone_clean, 'sha256'),
      'hex'
    )
  end;

  insert into public.members (
    collector_id,
    name_encrypted,
    phone_number_encrypted,
    phone_number_hash,
    daily_amount,
    status,
    created_via
  ) values (
    v_collector_id,
    v_name_secret,
    v_phone_secret,
    v_phone_hash,
    p_daily_amount,
    'active',
    p_created_via
  )
  returning id into v_member_id;

  insert into public.cycles (
    collector_id,
    member_id,
    cycle_number,
    start_date,
    end_date,
    status
  ) values (
    v_collector_id,
    v_member_id,
    1,
    v_today,
    v_today + interval '29 days',
    'active'
  );

  return v_member_id;
end;
$$;

-- Note: GRANT EXECUTE on this function was set in migration 0014; CREATE OR
-- REPLACE preserves grants. No re-grant needed.

comment on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) is
  'Atomic member + day-1 cycle creation. Story 2.2 = manual; Story 2.3 = contacts_import (pass p_created_via). Story 2.3 added phone_number_hash computation for the per-collector dedup constraint. Both INSERTs share this function''s transaction; any failure (vault, RLS, unique violation) rolls back both. Audit event member.created fires via the migration 0007 trigger.';
