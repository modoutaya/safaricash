-- Story 7.5 — Migration 0063: extend get_receipt_payload return shape with
-- cycle_start_date + cycle_end_date.
--
-- Baseline: migration 0043 (20260430000001_get_receipt_payload.sql, Story
-- 6.4). Story 7.5 adds 2 columns to the returns table so the receipt-URL
-- Worker can render the cycle period on the settlement receipt page (BDD
-- line 1165: "the receipt URL for this final SMS points to the settlement
-- receipt page (showing the cycle summary)").
--
-- The new columns are appended (non-breaking for PostgREST consumers: the
-- pre-Story-7.5 Worker that ignores unknown fields keeps working). The
-- existing JOIN on members stays implicit; a new JOIN on cycles is added
-- to source the dates.
--
-- Other behaviour preserved: filters out soft-undone transactions (Story
-- 4.5 handshake), returns 0 rows for unknown tokens, service-role-only
-- (GRANT EXECUTE unchanged).
--
-- See: _bmad-output/implementation-artifacts/7-5-cycle-settled-final-sms.md AC #5.

set check_function_bodies = off;

-- PostgreSQL forbids changing the RETURNS TABLE shape via CREATE OR REPLACE
-- (SQLSTATE 42P13). DROP first, then CREATE. Grants are re-issued below.
drop function if exists public.get_receipt_payload(text);

create function public.get_receipt_payload(p_token text)
returns table (
  amount             numeric(12, 0),
  kind               text,
  cycle_day          int,
  created_at         timestamptz,
  member_first_name  text,
  projected_balance  numeric(12, 0),
  daily_amount       numeric(12, 0),
  -- Story 7.5 — new columns for the settlement receipt page.
  cycle_start_date   date,
  cycle_end_date     date
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount,
    t.kind::text,
    t.cycle_day,
    t.created_at,
    substring(unaccent(public.vault_decrypt(m.name_encrypted)) from '^[^ ]+') as member_first_name,
    (m.daily_amount * 29) - coalesce(
      (
        select sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0))
          from public.transactions t2
         where t2.cycle_id = t.cycle_id
           and t2.kind = 'advance'
           and t2.undone_at is null
      ),
      0
    ) as projected_balance,
    m.daily_amount,
    c.start_date as cycle_start_date,
    c.end_date   as cycle_end_date
  from public.transactions t
  join public.members m on m.id = t.member_id
  join public.cycles  c on c.id = t.cycle_id
  where t.receipt_token = p_token
    and t.undone_at is null;
$$;

comment on function public.get_receipt_payload(text) is
  'Story 7.5 — receipt-page payload extended with cycle_start_date + cycle_end_date so the Worker can render the settlement receipt period. Story 6.4 baseline preserved: reads transactions_decrypted-equivalent (filters soft-undone rows), service_role only.';

-- Re-issue grants (the DROP above wiped them).
grant execute on function public.get_receipt_payload(text) to service_role;
revoke execute on function public.get_receipt_payload(text) from public;
revoke execute on function public.get_receipt_payload(text) from authenticated;
