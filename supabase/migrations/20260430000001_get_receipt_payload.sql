-- Story 6.4 — Migration 0043: get_receipt_payload SECURITY DEFINER RPC.
--
-- Returns the rendered-receipt-page payload for a given receipt_token.
-- The receipt-url Cloudflare Worker calls this via PostgREST RPC under
-- the service-role JWT. Reads transactions_decrypted (Story 4.5 handshake
-- — undone rows are excluded from the view).
--
-- Returns 0 rows when:
--   - The token does not exist.
--   - The transaction was soft-undone (`undone_at IS NOT NULL`).
--
-- See: _bmad-output/implementation-artifacts/6-4-receipt-url-worker.md AC #5.

set check_function_bodies = off;

create or replace function public.get_receipt_payload(p_token text)
returns table (
  amount             numeric(12, 0),
  kind               text,
  cycle_day          int,
  created_at         timestamptz,
  member_first_name  text,
  projected_balance  numeric(12, 0),
  daily_amount       numeric(12, 0)
)
language sql
security definer
set search_path = public, pg_temp
as $$
  -- Filter out soft-undone transactions (Story 4.5 handshake) — the
  -- transactions_decrypted view does this for the `where undone_at is
  -- null` filter; we replicate the filter here since transactions_decrypted
  -- doesn't expose receipt_token.
  select
    nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount,
    t.kind::text,
    t.cycle_day,
    t.created_at,
    -- First whitespace-delimited token of the unaccented decoded name.
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
    m.daily_amount
  from public.transactions t
  join public.members m on m.id = t.member_id
  where t.receipt_token = p_token
    and t.undone_at is null;
$$;

comment on function public.get_receipt_payload(text) is
  'Story 6.4 / FR30 — receipt-page payload for the receipt-url Worker. Reads transactions_decrypted (excludes Story 4.5 soft-undone rows); returns 0 rows for unknown / undone tokens. service_role only.';

grant execute on function public.get_receipt_payload(text) to service_role;
revoke execute on function public.get_receipt_payload(text) from public;
revoke execute on function public.get_receipt_payload(text) from authenticated;
