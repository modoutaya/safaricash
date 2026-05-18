-- Story 4.6 follow-up — collector display name.
--
-- public.users (collector accounts) stored only id / phone_number / role.
-- The dashboard greeting wants the collector's name ("Bonjour {prénom}").
-- Add a nullable `name` column: existing collectors are backfilled
-- manually in Supabase Studio until a collector-profile screen exists,
-- and a NULL name falls back to the generic "Bonjour Collecteur".
--
-- The collector self-RLS policy (users_self_all, migration 0002) already
-- lets a collector SELECT its own row, so no policy change is needed.

alter table public.users
  add column name text;

comment on column public.users.name is
  'Collector display name (Story 4.6 follow-up). Nullable — set at provisioning; a NULL name falls back to a generic dashboard greeting.';
