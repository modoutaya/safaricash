-- Story 2.2 — Migration 0014: created_via column + create_member_with_cycle RPC.
--
-- Story 2.2 implements FR7 (collector creates a member manually). The member
-- INSERT and the day-1 cycle INSERT must be atomic — a partial state
-- (orphan member with no cycle, or cycle with no member) breaks downstream
-- invariants from Stories 3.x (cycle engine) and 4.x (transaction capture).
--
-- Two changes packaged together:
--   1. New enum `members_created_via_enum` + non-null column `created_via`
--      on `public.members` with default `'manual'`. Story 2.3 (contacts
--      bulk import) will write `'contacts_import'` via the same RPC pattern
--      (or a sibling RPC if the contract diverges).
--   2. SECURITY DEFINER RPC `public.create_member_with_cycle(name, phone,
--      daily_amount)` that wraps both INSERTs in a single function /
--      transaction. Returns the new member's uuid. Audit event
--      `member.created` fires automatically via the trigger from
--      migration 0007.
--
-- Empty-phone handling: collectors at MVP often onboard cash-only savers
-- who have no phone number on file. The `phone_number_encrypted` column
-- is NOT NULL (migration 0005 invariant) so we cannot store NULL — instead
-- we store an encrypted empty string. The `members_decrypted` view returns
-- the plaintext empty string, which Story 2.1's `memberRowSchema` already
-- handles via `phone_number: z.string().nullable()` (the .nullable() was
-- added defensively in 2.1 even though the column is NOT NULL).
--
-- See: _bmad-output/implementation-artifacts/2-2-create-member-manual.md
-- AC #5 + Task 1.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. created_via enum + column.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'members_created_via_enum') then
    create type public.members_created_via_enum as enum ('manual', 'contacts_import');
  end if;
end;
$$;

alter table public.members
  add column if not exists created_via public.members_created_via_enum not null default 'manual';

comment on column public.members.created_via is
  'How the member was added: ''manual'' = single-form entry (Story 2.2), ''contacts_import'' = device contacts bulk picker (Story 2.3). Default ''manual'' keeps backward compat with any pre-existing rows.';

-- ---------------------------------------------------------------------------
-- 2. RPC — atomic create member + day-1 cycle.
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
  v_member_id     uuid;
  v_today         date := current_date;
begin
  -- 1. Resolve caller — auth.uid() reads the JWT claim from the request
  --    context. SECURITY DEFINER does not strip the claim, so this works
  --    correctly when invoked via PostgREST RPC.
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- 2. Validate inputs (defense-in-depth — client + Zod already validate).
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

  -- 3. Normalize phone — empty / whitespace / null all become empty string.
  --    The column is NOT NULL so we encrypt the empty string rather than
  --    flipping the schema.
  v_phone_clean := coalesce(trim(p_phone_number), '');

  -- 4. Encrypt name + phone via the Story 1.2 vault_encrypt helper.
  v_name_secret  := public.vault_encrypt(trim(p_name));
  v_phone_secret := public.vault_encrypt(v_phone_clean);

  -- 5. INSERT member. The audit trigger from migration 0007 fires
  --    `member.created` on this INSERT — no manual emit needed.
  insert into public.members (
    collector_id,
    name_encrypted,
    phone_number_encrypted,
    daily_amount,
    status,
    created_via
  ) values (
    v_collector_id,
    v_name_secret,
    v_phone_secret,
    p_daily_amount,
    'active',
    p_created_via
  )
  returning id into v_member_id;

  -- 6. INSERT the day-1 cycle (30 calendar days inclusive).
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

comment on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) is
  'Atomic member + day-1 cycle creation. Used by Story 2.2 (manual) and Story 2.3 (contacts import — pass p_created_via = ''contacts_import''). Both INSERTs share the function transaction; any failure (vault, RLS, constraint) rolls back both. Audit event member.created fires via the migration 0007 trigger.';

revoke all on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) from public;
revoke all on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) from anon;
grant execute on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) to authenticated;
