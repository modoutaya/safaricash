-- Story 6.7 — Migration 0054: expose receipt_token in transactions_decrypted.
--
-- Re-derived from migration 0031 (Story 4.5,
-- 20260426000006_transactions_decrypted_excludes_undone.sql) byte-for-byte
-- EXCEPT adds `t.receipt_token` to the SELECT list. Story 6.7's share
-- button needs the token client-side to compose ${VITE_RECEIPT_URL_BASE}/{token}
-- without a server round-trip.
--
-- receipt_token is not a saver secret (it is the public-access capability for
-- the Story 6.4 receipt URL Worker). The authenticated collector already has
-- select on every transaction they own via RLS, so exposing this column
-- through the existing decrypted view introduces no new attack surface.
--
-- See: _bmad-output/implementation-artifacts/6-7-per-transaction-receipt-share.md AC #1.

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
  nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount,
  t.cycle_day,
  t.source,
  t.created_at,
  t.updated_at,
  t.days_covered,
  t.receipt_token
from public.transactions t
where t.undone_at is null;

comment on view public.transactions_decrypted is
  'Decrypted projection of transactions. amount is numeric(12,0). security_invoker = true → caller RLS on transactions applies. Story 4.5: filters undone rows. Story 6.7: exposes receipt_token for collector-side share/resend.';

grant select on public.transactions_decrypted to authenticated;
