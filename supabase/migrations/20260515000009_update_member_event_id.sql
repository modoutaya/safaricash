-- Story 8.6 — update_member accepts p_event_id for idempotent offline-edit
-- replay.
--
-- Story 8.4 gave the record-* RPCs a p_event_id so a reconciler retry
-- (request succeeded server-side, response lost in transit) does not
-- double-insert. update_member has the same exposure: an absolute-state
-- UPDATE is idempotent for the member DATA, but the audit_members trigger
-- (migration 0007) fires on every UPDATE — a retry would emit a SECOND
-- member.updated audit row for one logical edit.
--
-- Fix: a nullable members.last_event_id column records the most recent
-- reconciled offline edit's event id. The RPC early-returns when
-- p_event_id is provided and already equals the owner's last_event_id —
-- no second UPDATE, no second audit emission. When p_event_id is NULL
-- (the online edit path) the guard is skipped and behaviour is unchanged.
--
-- DROP + CREATE (not CREATE OR REPLACE): adding a parameter changes the
-- signature, which CREATE OR REPLACE cannot do (SQLSTATE 42P13) — same
-- workaround as Stories 7.5 / 8.4. The GRANT is re-applied below.
--
-- The members_decrypted view is NOT re-derived: last_event_id is a
-- server-only bookkeeping column (the RPC reads `members` directly); no
-- client surface reads it, so the explicit view projection stays as-is
-- (memory project_views_after_columns.md — intentional omission).

set check_function_bodies = off;

alter table public.members
  add column if not exists last_event_id uuid;

drop function if exists public.update_member(uuid, text, text, integer);

create or replace function public.update_member(
  p_id           uuid,
  p_name         text,
  p_phone_number text,
  p_daily_amount integer,
  p_event_id     uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id   uuid;
  v_phone_clean    text;
  v_phone_hash     text;
  v_current_name   text;
  v_current_phone  text;
  v_name_secret    uuid;
  v_phone_secret   uuid;
  v_rows_updated   integer;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- Story 8.6 — idempotent replay early-return. When the reconciler
  -- retries an offline edit whose first attempt already applied, the
  -- owner's last_event_id already equals p_event_id → skip entirely
  -- (no second UPDATE, no second member.updated audit row).
  if p_event_id is not null then
    if (
      select last_event_id
        from public.members
       where id = p_id
         and collector_id = v_collector_id
    ) = p_event_id then
      return;
    end if;
  end if;

  -- Defense-in-depth validation (mirrors create_member_with_cycle).
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

  -- Read current decrypted values via members_decrypted (security_invoker;
  -- combined with the explicit collector_id check it is safe).
  select md.name, md.phone_number
    into v_current_name, v_current_phone
    from public.members_decrypted md
   where md.id = p_id
     and md.collector_id = v_collector_id;

  -- Conditional re-encrypt — only when the plaintext actually changed.
  if v_current_name is null or trim(p_name) is distinct from v_current_name then
    v_name_secret := public.vault_encrypt(trim(p_name));
  end if;
  if v_current_phone is null or v_phone_clean is distinct from coalesce(v_current_phone, '') then
    v_phone_secret := public.vault_encrypt(v_phone_clean);
    v_phone_hash := case
      when v_phone_clean = '' then null
      else encode(
        extensions.digest(v_collector_id::text || ':' || v_phone_clean, 'sha256'),
        'hex'
      )
    end;
  end if;

  update public.members
     set name_encrypted         = coalesce(v_name_secret, name_encrypted),
         phone_number_encrypted = coalesce(v_phone_secret, phone_number_encrypted),
         phone_number_hash      = case
                                    when v_phone_secret is not null then v_phone_hash
                                    else phone_number_hash
                                  end,
         daily_amount           = p_daily_amount,
         -- Story 8.6 — record the reconciled event id (NULL on the online
         -- path leaves the column untouched).
         last_event_id          = coalesce(p_event_id, last_event_id),
         updated_at             = now()
   where id = p_id
     and collector_id = v_collector_id;

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then
    raise exception 'not_found: member % does not exist or is not owned by caller', p_id
      using errcode = 'P0002';
  end if;
end;
$$;

grant execute on function public.update_member(uuid, text, text, integer, uuid) to authenticated;

comment on function public.update_member(uuid, text, text, integer, uuid) is
  'Atomic member edit (Story 2.5 / FR10). Story 8.6 adds optional p_event_id for idempotent reconciler replay: when provided and the owner''s members.last_event_id already equals it, the RPC returns early WITHOUT a second UPDATE or member.updated audit row. Re-encrypts name/phone only when plaintext changed. Raises 28000 (unauthorized), 22000 (validation), P0002 (not_found), 23505 (duplicate_phone).';
