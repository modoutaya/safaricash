-- Story 6.5 — Migration 0049: find_members_by_phone helper for the
-- Termii STOP-keyword webhook (sms-inbound Edge Function).
--
-- The webhook receives a phone number and needs to find every matching
-- member across collectors. Vault hashes on encrypt — there's no reverse
-- index — so we scan members and decrypt each phone in a SECURITY
-- DEFINER context. Acceptable for MVP volumes; a future story can add
-- a hashed-phone normalisation column for O(1) lookup.
--
-- See: _bmad-output/implementation-artifacts/6-5-first-sms-consent-optout.md AC #5.

set check_function_bodies = off;

create or replace function public.find_members_by_phone(p_phone text)
returns table (id uuid)
language sql
security definer
set search_path = public, pg_temp
as $$
  select m.id
    from public.members m
   where trim(coalesce(public.vault_decrypt(m.phone_number_encrypted), '')) = trim(p_phone)
     and m.status = 'active';
$$;

comment on function public.find_members_by_phone(text) is
  'Story 6.5 — reverse-phone lookup for the Termii STOP-keyword webhook. Vault has no reverse index; this is an O(N) scan over active members. Acceptable for MVP volumes (low inbound webhook frequency).';

grant execute on function public.find_members_by_phone(text) to service_role;
revoke execute on function public.find_members_by_phone(text) from public;
revoke execute on function public.find_members_by_phone(text) from authenticated;
