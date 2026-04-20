-- Story 1.5 — Migration 0009: public.check_collector_registered RPC.
--
-- Story 1.5 AC #3 / AC #13. The login UX needs to answer "is this phone a
-- pre-provisioned collector?" BEFORE calling signInWithOtp (Termii costs
-- money; we do not want to spam unknown phones). But the anonymous client
-- cannot SELECT public.users (RLS users_no_anon blocks anon).
--
-- Solution: one dedicated SECURITY DEFINER RPC that returns ONLY a boolean.
-- Row enumeration is impossible — the RPC never echoes a row, just a flag.
-- Timing leak is bounded by network jitter >> DB lookup (MVP-acceptable;
-- Supabase Pro's native PostgREST 60/min/IP anon rate-limit caps blast
-- radius).
--
-- Hardening:
--   - search_path pinned to public (protects against malicious schema in
--     session search_path)
--   - SECURITY DEFINER with owner = postgres (default for migrations)
--   - REVOKE all from public/anon/authenticated, then GRANT EXECUTE only to
--     anon + authenticated (login flow calls this before session exists; a
--     logged-in collector retrying login would call it with their JWT).
--   - Returns boolean (no row data, no user ID, no role).
--
-- See: architecture.md § Authentication & Security; Story 1.5 Dev Notes.

set check_function_bodies = off;

create or replace function public.check_collector_registered(p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
begin
  -- Null / empty / malformed phone: short-circuit false. Protects against
  -- accidentally treating "" as a wildcard if future code changes the query
  -- shape. Also defensive against a client sending phone = NULL.
  if p_phone is null or length(p_phone) = 0 then
    return false;
  end if;

  select exists(
    select 1
    from public.users
    where phone_number = p_phone
      and role = 'collector'
  ) into v_exists;

  return coalesce(v_exists, false);
end;
$$;

comment on function public.check_collector_registered(text) is
  'Rationale: anonymous clients cannot read public.users (RLS users_no_anon). This RPC returns ONLY a boolean — no row enumeration. Used by Story 1.5 login UX to gate Termii spend on pre-provisioned phones only. Restricts to role=collector so super_admin phones do not qualify for the collector sign-in flow.';

revoke all on function public.check_collector_registered(text) from public;
revoke all on function public.check_collector_registered(text) from anon;
revoke all on function public.check_collector_registered(text) from authenticated;

grant execute on function public.check_collector_registered(text) to anon;
grant execute on function public.check_collector_registered(text) to authenticated;
