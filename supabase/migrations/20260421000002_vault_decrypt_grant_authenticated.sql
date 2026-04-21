-- Story 2.1 — grant EXECUTE on vault_decrypt(uuid) to authenticated.
--
-- Migration 0005 originally REVOKEd this on the premise that authenticated
-- could enumerate arbitrary secret_ids. In practice:
--   1. authenticated ONLY knows secret_ids that live in rows RLS lets them
--      see (members.{name,phone_number}_encrypted,
--      transactions.amount_encrypted). Enumeration by uuid v4 is a 2^122
--      search space — not a realistic threat at MVP scale.
--   2. The members_decrypted + transactions_decrypted views are declared
--      with `security_invoker = true` so caller-side RLS applies — but the
--      view's SELECT expansion CALLS vault_decrypt in the caller's
--      privilege context. Without EXECUTE, authenticated cannot read the
--      decrypted views at all (the underlying reason is Postgres checks
--      EXECUTE before SECURITY DEFINER switches the body's privilege
--      context).
--   3. Story 2.1's member list is the first real consumer of this path.
--      Story 1.2 shipped the views without a consumer so the permission
--      gap went unnoticed until now.
--
-- Trade-off revisit: the Growth-scale HMAC-search-column upgrade described
-- in docs/ADR/001-supabase-vault.md § Search-on-encrypted-columns would
-- remove the reliance on view-level decryption at read time, at which
-- point we could re-REVOKE this grant.

grant execute on function public.vault_decrypt(uuid) to authenticated;

comment on function public.vault_decrypt(uuid) is
  'SECURITY DEFINER wrapper around vault.decrypted_secrets. Returns plaintext for a given secret_id. Caller needs EXECUTE (granted to authenticated + service_role) to invoke. Leak surface bounded by RLS on the owning table — authenticated can only decrypt secret_ids they already see via RLS on members/transactions/etc. uuid v4 enumeration is not a realistic threat at MVP scale. See migration 0005 § vault_decrypt for the original rationale and Story 2.1 migration 20260421000002 for the grant motivation.';
