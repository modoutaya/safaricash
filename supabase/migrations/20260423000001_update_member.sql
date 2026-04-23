-- Story 2.5 — Migration 0016: SECURITY DEFINER update_member RPC.
--
-- Mirrors create_member_with_cycle (migrations 0014 + 0015):
--   - SECURITY DEFINER + set search_path so RLS doesn't apply.
--   - Re-validates name length 2..80 and daily_amount 100..100000.
--   - Encrypted columns stay encrypted: only re-encrypts when the new
--     plaintext differs from the current decrypted value (avoids burning
--     fresh vault secrets + polluting the audit chain with no-op diffs).
--   - Recomputes phone_number_hash on phone change (Story 2.3 salted hash).
--     Empty/null phone → null hash (excluded from the unique partial index).
--   - Audit `member.updated` event fires automatically via the audit_members
--     trigger from migration 0007 — NO manual emission.
--
-- The RPC returns void; the caller refetches via TanStack Query invalidation.
--
-- See: _bmad-output/implementation-artifacts/2-5-edit-member-impact-alert.md
-- AC #8 + Task 0.

set check_function_bodies = off;

create or replace function public.update_member(
  p_id           uuid,
  p_name         text,
  p_phone_number text,
  p_daily_amount integer
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

  -- Read current decrypted values via members_decrypted. The view is
  -- security_invoker, so this select sees only this collector's row when
  -- the caller is the owner — combined with the explicit collector_id check
  -- below it's safe. If no row matches (wrong id OR not the owner), we
  -- fall through to the UPDATE which will affect 0 rows → not_found.
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

grant execute on function public.update_member(uuid, text, text, integer) to authenticated;

comment on function public.update_member(uuid, text, text, integer) is
  'Atomic member edit (Story 2.5 / FR10). Re-encrypts name/phone only when plaintext changed; recomputes phone_number_hash on phone change. Audit event member.updated fires via the migration 0007 trigger. Raises 28000 (unauthorized), 22000 (validation), P0002 (not_found), 23505 (duplicate_phone via partial unique index).';
