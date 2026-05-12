-- Story 6.7 — Migration 0056: expose sms_opt_out in members_decrypted.
--
-- Re-derived from migration 0005 (Story 1.2 vault setup) byte-for-byte
-- EXCEPT adds `m.sms_opt_out` to the SELECT list. Story 6.7's
-- TransactionReceiptSheet disables the "Renvoyer par SMS" button when
-- the saver has opted out, and the gate is read via the decrypted view
-- in useMemberProfile.
--
-- The column was added to `public.members` by Story 6.5 migration 0044
-- but never propagated to the view — production callers reading via
-- `members_decrypted` see PostgREST "column does not exist" errors when
-- they try to SELECT it. Fixed in this migration.
--
-- sms_opt_out is not a saver secret (it's a flag the SAVER sets via the
-- STOP keyword or the receipt URL opt-out link) — exposing it through
-- the authenticated read path is semantics-only; no new attack surface.
--
-- See: _bmad-output/implementation-artifacts/6-7-per-transaction-receipt-share.md AC #12.

create or replace view public.members_decrypted
with (security_invoker = true)
as
select
  m.id,
  m.collector_id,
  public.vault_decrypt(m.name_encrypted)         as name,
  public.vault_decrypt(m.phone_number_encrypted) as phone_number,
  m.daily_amount,
  m.status,
  m.created_at,
  m.updated_at,
  m.sms_opt_out
from public.members m;

comment on view public.members_decrypted is
  'Decrypted projection of members. security_invoker = true → caller RLS on members applies (per-collector isolation). Story 6.7: exposes sms_opt_out for the per-transaction receipt sheet''s SMS-button gate.';

grant select on public.members_decrypted to authenticated;
