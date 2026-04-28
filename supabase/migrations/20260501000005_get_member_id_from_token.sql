-- Story 6.5 — Migration 0048: get_member_id_from_token helper RPC.
--
-- Lighter lookup than get_receipt_payload (Story 6.4) — used by the
-- receipt-url Worker POST /r/{token}/opt-out path. Returns the member_id
-- for a given non-undone receipt_token, or NULL if unknown or undone.
--
-- See: _bmad-output/implementation-artifacts/6-5-first-sms-consent-optout.md AC #6.

set check_function_bodies = off;

create or replace function public.get_member_id_from_token(p_token text)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select t.member_id
    from public.transactions t
   where t.receipt_token = p_token
     and t.undone_at is null
   limit 1;
$$;

comment on function public.get_member_id_from_token(text) is
  'Story 6.5 — receipt-url Worker opt-out lookup. Returns member_id for non-undone transactions or NULL.';

grant execute on function public.get_member_id_from_token(text) to service_role;
revoke execute on function public.get_member_id_from_token(text) from public;
revoke execute on function public.get_member_id_from_token(text) from authenticated;
