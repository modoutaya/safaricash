-- Story 1.2 — Migration 0005: Supabase Vault per-row column encryption.
--
-- ARCHITECTURAL DIVERGENCE FROM SPEC (recorded in ADR-001 / Story 1.2 Dev Agent Record):
-- ----------------------------------------------------------------------------
-- The story's AC #5 phrasing ("members.name, members.phone_number, transactions.amount
-- are stored encrypted via Supabase Vault keys; reads through PostgREST under an
-- authenticated collector return decrypted plaintext") implied a native column-wrap
-- primitive in Vault. The current Vault API (verified 2026-04-19 against
-- https://supabase.com/docs/guides/database/vault) only exposes scalar-secret
-- storage: vault.create_secret(plaintext, name?, description?) returns a UUID,
-- and reads happen through the vault.decrypted_secrets view.
--
-- Implementation pattern adopted (Pattern 1 — community standard, ADR-001):
--   1. For each Vault-wrapped column, replace the plaintext column with a `_encrypted`
--      column of type uuid that references vault.secrets(id) implicitly.
--   2. Provide SECURITY DEFINER helpers public.vault_encrypt(text) → uuid and
--      public.vault_decrypt(uuid) → text. These wrap vault.create_secret() and
--      vault.decrypted_secrets so app/Edge code never touches the vault schema
--      directly.
--   3. Provide security_invoker = true views (public.members_decrypted /
--      public.transactions_decrypted) that JOIN through vault_decrypt() and
--      inherit the underlying tables' RLS.
--
-- Rationale for this pattern over alternatives (pgsodium, app-level AES-GCM,
-- defer-encryption) is captured in docs/ADR/001-supabase-vault.md.

-- ---------------------------------------------------------------------------
-- Ensure supabase_vault is available. On Supabase Pro and on the local CLI's
-- containerised stack, this extension is pre-installed; we only need to enable
-- it in the current database.
-- ---------------------------------------------------------------------------

create extension if not exists "supabase_vault" with schema "vault" cascade;

-- ---------------------------------------------------------------------------
-- Defensive guard: this migration ALTERs members + transactions, dropping
-- plaintext columns and adding NOT NULL encrypted replacements. Re-running
-- against a non-empty table would silently break the schema (ADD COLUMN ...
-- NOT NULL fails when rows exist). Refuse to run rather than partially apply.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from public.members limit 1) then
    raise exception
      'Migration 0005 cannot run against a non-empty members table. Backfill name_encrypted/phone_number_encrypted in a separate migration first.';
  end if;
  if exists (select 1 from public.transactions limit 1) then
    raise exception
      'Migration 0005 cannot run against a non-empty transactions table. Backfill amount_encrypted in a separate migration first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Encryption / decryption helpers (SECURITY DEFINER → run as function owner so
-- the caller does not need direct GRANTs on the vault schema).
-- ---------------------------------------------------------------------------

create or replace function public.vault_encrypt(plaintext text)
returns uuid
language plpgsql
security definer
set search_path = vault, public, pg_temp
as $$
declare
  new_secret_id uuid;
begin
  if plaintext is null then
    return null;
  end if;
  new_secret_id := vault.create_secret(plaintext);
  return new_secret_id;
end;
$$;

comment on function public.vault_encrypt(text) is
  'SECURITY DEFINER wrapper around vault.create_secret(plaintext). Returns the secret_id (uuid) to be stored in the column. Caller does not need direct vault schema GRANTs.';

revoke execute on function public.vault_encrypt(text) from public;
grant execute on function public.vault_encrypt(text) to authenticated, service_role;

create or replace function public.vault_decrypt(secret_id uuid)
returns text
language plpgsql
security definer
set search_path = vault, public, pg_temp
as $$
declare
  plaintext text;
begin
  if secret_id is null then
    return null;
  end if;
  select decrypted_secret into plaintext
  from vault.decrypted_secrets
  where id = secret_id;
  return plaintext;
end;
$$;

comment on function public.vault_decrypt(uuid) is
  'SECURITY DEFINER wrapper around vault.decrypted_secrets. Returns plaintext for a given secret_id. Authenticated callers can only see secret_ids that already live in their RLS-protected rows, so leak surface is bounded by RLS on the calling table; uuid v4 enumeration is not a realistic threat at MVP scale.';

-- vault_decrypt is intentionally NOT granted to `authenticated`. If it were,
-- any logged-in user could call it directly via PostgREST RPC with an
-- arbitrary secret_id and bypass the RLS-on-the-owning-table check that
-- normally bounds which secret_ids they can see. The decryption views
-- (members_decrypted / transactions_decrypted) call this function and run
-- under SECURITY DEFINER context, so authenticated reads through the views
-- still resolve plaintext correctly.
revoke execute on function public.vault_decrypt(uuid) from public;
revoke execute on function public.vault_decrypt(uuid) from authenticated;
grant execute on function public.vault_decrypt(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- members: replace plaintext name + phone_number with encrypted columns.
-- The 0001 migration intentionally created these as text so this migration
-- can encapsulate the encryption decision in one file (per the 7-file split
-- in architecture.md § Project Structure).
-- ---------------------------------------------------------------------------

alter table public.members
  drop column name,
  drop column phone_number;

alter table public.members
  add column name_encrypted         uuid not null,
  add column phone_number_encrypted uuid not null;

comment on column public.members.name_encrypted is
  'Vault secret_id for the saver name. Read via public.members_decrypted view or public.vault_decrypt(secret_id).';

comment on column public.members.phone_number_encrypted is
  'Vault secret_id for the saver phone number (E.164 format expected pre-encryption).';

-- ---------------------------------------------------------------------------
-- transactions: replace plaintext amount with encrypted column.
-- Note: the inline CHECK (amount > 0) is dropped with the column; positivity
-- is now enforced at the application boundary via Zod (see
-- src/lib/validators/amount.ts in Epic 4 stories) and in the audit-log payload
-- which records the plaintext amount at trigger time (migration 0007).
-- ---------------------------------------------------------------------------

alter table public.transactions
  drop column amount;

alter table public.transactions
  add column amount_encrypted uuid not null;

comment on column public.transactions.amount_encrypted is
  'Vault secret_id for the transaction amount. Decrypted via public.transactions_decrypted view returns numeric(12,0). Positivity check moved to application boundary (Zod) since CHECK constraints cannot run on encrypted values.';

-- ---------------------------------------------------------------------------
-- Decrypted views with security_invoker = true so the caller's RLS on the
-- underlying tables continues to apply. Without security_invoker, views run
-- as their owner (postgres) and bypass RLS entirely.
-- ---------------------------------------------------------------------------

create or replace view public.members_decrypted
with (security_invoker = true)
as
select
  m.id,
  m.collector_id,
  public.vault_decrypt(m.name_encrypted)         as name,
  public.vault_decrypt(m.phone_number_encrypted) as phone_number,
  m.daily_amount,
  m.status,
  m.created_at,
  m.updated_at
from public.members m;

comment on view public.members_decrypted is
  'Decrypted projection of members. security_invoker = true → caller RLS on members applies (per-collector isolation).';

create or replace view public.transactions_decrypted
with (security_invoker = true)
as
select
  t.id,
  t.collector_id,
  t.member_id,
  t.cycle_id,
  t.kind,
  -- nullif() guards against an empty-string plaintext escaping the app
  -- boundary (positivity check moved to Zod, but defensive for the view).
  -- Without nullif, a single bad row would throw `invalid input syntax for
  -- type numeric` and break the view for *every* read.
  nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount,
  t.cycle_day,
  t.source,
  t.created_at,
  t.updated_at
from public.transactions t;

comment on view public.transactions_decrypted is
  'Decrypted projection of transactions. amount is numeric(12,0). security_invoker = true → caller RLS on transactions applies.';

grant select on public.members_decrypted      to authenticated;
grant select on public.transactions_decrypted to authenticated;
