-- Story 1.5b — Migration 0013: drop reauth_challenges table + related helpers.
--
-- PRD v1.3 auth pivot. Story 1.3's SMS-OTP re-auth challenge machinery
-- (table, helper functions, enums, vault HMAC key) is replaced by a
-- simpler flow: the /re-auth Edge Function verifies the caller's
-- password directly against Supabase Auth's signInWithPassword on a
-- fresh anon client. No per-challenge persistence needed; no raw or
-- hashed OTPs stored.
--
-- Drop order preserves dependencies:
--   1. Table (CASCADE drops its indexes, its triggers, and any
--      RLS policies attached to it).
--   2. Helper functions (they reference the composite types).
--   3. Composite types (they reference the enum).
--   4. Enum types.
--   5. Vault secret (reauth_otp_hmac_key).
--
-- The audit_emit() function retains its reauth_challenges case branches
-- as dead code after this migration — they never fire because the
-- trigger binding dies with the table. If a future migration re-creates
-- the table (e.g., post-KYC revert), re-audit the audit_emit() branches
-- before relying on them. Not dropping audit_emit() here because it is
-- the shared audit trigger body for every other mutation table.
--
-- See: _bmad-output/implementation-artifacts/1-5b-password-auth-switch.md
-- AC #7 + Task 3; supersedes supabase/migrations/20260419000008_reauth_challenges.sql.

-- 1. Drop the table (CASCADE removes dependent indexes, triggers, RLS).
drop table if exists public.reauth_challenges cascade;

-- 2. Drop helper functions that took composite types as return.
drop function if exists public.reauth_consume_confirmation(uuid, uuid, public.reauth_intended_op_enum);
drop function if exists public.reauth_mark_verified(uuid, uuid);
drop function if exists public.reauth_record_failed_verify(uuid, uuid);
drop function if exists public.get_reauth_otp_hmac_key();

-- 3. Drop composite types (they depend on the enum below).
drop type if exists public.reauth_mark_verified_result;
drop type if exists public.reauth_verify_outcome;

-- 4. Drop enums.
drop type if exists public.reauth_challenge_status_enum;
drop type if exists public.reauth_intended_op_enum;

-- 5. Delete the vault secret. Guarded so the migration is idempotent on a
--    project where the secret was never provisioned (e.g., fresh local DB).
do $$
declare
  sec_id uuid;
begin
  select id into sec_id from vault.secrets where name = 'reauth_otp_hmac_key';
  if sec_id is not null then
    delete from vault.secrets where id = sec_id;
  end if;
end;
$$;
