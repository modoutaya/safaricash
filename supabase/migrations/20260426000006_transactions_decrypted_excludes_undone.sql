-- Story 4.5 — Migration 0031: filter undone rows from transactions_decrypted.
--
-- Adds `where t.undone_at is null` to the security_invoker view so undone
-- transactions disappear from member-profile transaction history (Story
-- 2.4) and from any future read that goes through the decrypted view.
-- The raw `transactions` table still has the row — auditors can query it
-- directly via the audit chain.
--
-- See: _bmad-output/implementation-artifacts/4-5-undo-transaction-window.md AC #5.

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
  t.days_covered
from public.transactions t
where t.undone_at is null;

comment on view public.transactions_decrypted is
  'Decrypted projection of transactions. amount is numeric(12,0). security_invoker = true → caller RLS on transactions applies. Story 4.5: filters undone rows.';

grant select on public.transactions_decrypted to authenticated;
