-- 2026-05-29 — opt in early to Supabase's "tables in public are not exposed
-- to the Data API by default" change. Ref: changelog discussion #45329
-- (https://github.com/orgs/supabase/discussions/45329). Supabase enforces
-- this on all existing projects on 2026-10-30; running it now means any
-- future migration that creates a table in public without an explicit
-- GRANT fails loudly in local dev / CI instead of silently breaking prod
-- after the cutover.
--
-- What this changes:
--   - Default privileges for role `postgres` in schema `public` no longer
--     grant select/insert/update/delete on FUTURE tables (and views) to
--     anon / authenticated / service_role.
--   - Same for usage/select on FUTURE sequences.
--
-- What this does NOT change:
--   - Existing tables (users, members, cycles, transactions, sms_queue,
--     disputes, audit_log — all created in 20260419000001_init_schema.sql)
--     keep their current grants. The running app stays reachable.
--   - The members_decrypted / transactions_decrypted views keep their
--     explicit grants (re-issued in each CREATE OR REPLACE migration).
--   - Functions/RPCs already use explicit GRANT EXECUTE.
--
-- From this migration on, any new table in `public` exposed via the Data
-- API (PostgREST / GraphQL / supabase-js) MUST include explicit GRANT
-- statements alongside ENABLE ROW LEVEL SECURITY and CREATE POLICY. See
-- the canonical snippet in CLAUDE.md.
--
-- Rollback (if this ever needs to be undone): see the FAQ section of
-- discussion #45329 — restore default privileges + bulk-grant any tables
-- created since this migration.

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
