# Story 10.4: Saver anonymisation Edge Function for right-to-deletion

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **saver**,
I want **to request the deletion of my personal data and trust that my request is honoured while regulatory retention obligations are respected**,
so that **I can exercise my UEMOA data-protection rights — my name and phone are destroyed, but the transaction audit trail survives under an anonymous reference (FR48, AR13).**

> **FOURTH story of Epic 10 (Saver Dispute Flow & Data Rights).** Stories 10.1–10.3 shipped the dispute pipeline (capture → fan-out → collector surface). Story 10.4 ships the **data-rights** half of the epic: the right-to-deletion as **anonymisation, not hard-delete** — the `members` row is retained so every transaction that references it keeps its hash-chained audit integrity, but the PII (name, phone) is irreversibly destroyed.
>
> **What 10.4 ships:**
> 1. **The `saver-delete` Edge Function** (`supabase/functions/saver-delete/index.ts` — AR13, currently non-existent). A service-role-only `POST /functions/v1/saver-delete` that takes `{ member_id, confirm }`, validates, and delegates to a new `anonymise_member` RPC. Thin wrapper — the DB work lives in the RPC (mirrors Story 10.1: the receipt Worker calls `flag_transaction_dispute`).
> 2. **The `anonymise_member(p_member_id uuid)` SECURITY DEFINER RPC.** Idempotent, `service_role`-only. It (a) overwrites the member's two Vault secrets in place with salted hashes via `vault.update_secret` — destroying the plaintext; (b) clears `phone_number_hash`; (c) sets `sms_opt_out`; (d) stamps `anonymised_at`; (e) abandons in-flight queued SMS. One `members` UPDATE → the `audit_members` trigger hash-chains a `member.anonymised` event.
> 3. **One migration** — adds `members.anonymised_at`, extends the `sms_opt_out_via` CHECK with `'anonymisation'`, `CREATE OR REPLACE`s `audit_emit()` (a `member.anonymised` branch) + the `members_decrypted` view (exposes `anonymised_at`), and creates the `anonymise_member` RPC.
>
> **The anonymisation, precisely:**
> - **Irreversible by construction.** The two replacement hashes are derived from server-side identifiers (`collector_id` + `member_id`) — NOT from the plaintext name/phone. So even with full DB access there is no plaintext to recover and nothing to brute-force. `vault.update_secret` overwrites the original secret content in place — the plaintext is gone from Vault, not merely orphaned. There is no un-anonymise function.
> - **Audit trail preserved.** Transactions are NOT touched — their `member_id` FK still points at the (now anonymous) `members` row; the append-only `audit_log` is never rewritten. The whole hash chain still verifies.
> - **`member.anonymised` event.** A single `members` UPDATE (the `anonymised_at` NULL→NOT NULL transition) drives a new `audit_emit()` CASE branch. The audit payload carries only the encrypted-column UUIDs — never plaintext PII.
>
> **Code-reuse map (DO NOT re-invent):**
> - **The Edge Function shell** — `supabase/functions/dispute-notify/index.ts` is the template: `constantTimeEquals` + `isServiceRole(req)` service-role gate, `problem`/`problemResponse` (`_shared/rfc7807.ts`) for errors, `logJson` structured logging, the `globalThis.Deno?.serve` guarded entry point, `createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })`.
> - **The RPC pattern** — `set_member_sms_opt_out` (`supabase/migrations/20260501000004_set_member_sms_opt_out.sql`): SECURITY DEFINER, `set search_path`, not-found raise, **idempotent early-return**, the queued-SMS abandon UPDATE, `service_role`-only grants. `anonymise_member` mirrors it closely.
> - **The Vault layer** — `supabase/migrations/20260419000005_vault_setup.sql`: `vault_encrypt` / `vault_decrypt`. `members.name_encrypted` / `phone_number_encrypted` are `uuid` pointers into `vault.secrets`. 10.4 uses **`vault.update_secret(secret_id, new_plaintext)`** to overwrite the secret content in place — no new secret rows, no orphans.
> - **The `audit_emit()` rebase** — `supabase/migrations/20260516213715_dispute-resolved-audit.sql` is the **current** definition. `CREATE OR REPLACE` MUST start from THAT body and preserve every branch (2.5 actor-JWT fallback, 3.3 `cycle.transitioned`, 4.5 `transaction.undone`, 10.1 `dispute.flagged`, 10.3 `dispute.resolved`).
> - **The salted-hash idiom** — `encode(extensions.digest(<input>, 'sha256'), 'hex')`, exactly as `phone_number_hash` (`20260422000002`) and the audit serialiser use it.
> - **Deno tests** — `supabase/functions/dispute-notify/index.test.ts` + `_shared/test-fixtures.ts` (`seedCollector`, `seedMemberWithCycle`, `cleanup`).
>
> **What Story 10.4 does NOT ship:**
> - Any receipt-URL `/r/{token}/delete` route or UI surface — the epic says "via receipt URL page action **or direct support**"; at MVP the function is invoked by **support/founder** with the service-role key. A saver-facing surface is a later story.
> - Any `src/` (React app) change. No new npm dependency.
> - Any change to `members.status` — the row stays at its current status; `anonymised_at` is the sole anonymisation marker. (Changing `status` would ripple through dashboard/cycle queries — explicitly out of scope.)
> - Reversal / un-anonymise.
> - The hard-delete `delete_member` RPC (Story 2.6) — untouched.
> - Story 10.5 (the receipt-URL SMS opt-out surface).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** trace to the `epics.md:1379-1388` BDD; the rest are spec-derived constraints.

### The migration — schema + audit + RPC

1. **`members.anonymised_at` column.** A new migration `supabase/migrations/<timestamp>_saver-anonymisation.sql` (create via `npm run db:migrate:new saver-anonymisation`) adds `anonymised_at timestamptz NULL` to `public.members`. NULL = not anonymised; NOT NULL = irreversibly anonymised. This is the idempotency guard, the `audit_emit` trigger signal, and the marker Story 10.5 reads to gate its opt-out surface.

2. **`sms_opt_out_via` CHECK extended.** The migration drops and re-adds the `members.sms_opt_out_via` CHECK constraint (added inline by migration `20260501000001`, auto-named `members_sms_opt_out_via_check` — verify the exact name with `\d public.members` or in that migration) so the allowed set becomes `('stop_keyword', 'receipt_url', 'collector_action', 'anonymisation')`. Anonymisation records `sms_opt_out_via = 'anonymisation'` — accurate provenance, distinct from a collector- or saver-initiated opt-out.

3. **`audit_emit()` gains a `member.anonymised` branch.** The migration `CREATE OR REPLACE`s `public.audit_emit()` **starting from its current body** (`20260516213715_dispute-resolved-audit.sql`), preserving EVERY existing branch. ONE new CASE line is added, placed **before** the generic `members`/`UPDATE` line:
   ```sql
   when v_entity_table = 'members' and v_op = 'UPDATE'
        and (v_payload->>'anonymised_at') is not null
        and (to_jsonb(old)->>'anonymised_at') is null   then 'member.anonymised'
   ```
   The `audit_log.event_type` CHECK (migration 0003) is the regex `^[a-z][a-z_]*\.[a-z][a-z_]*$` — `member.anonymised` already matches; NO constraint change. The `audit_members` trigger already fires `AFTER INSERT OR UPDATE OR DELETE` — NO trigger change (unlike Story 10.3, which had to extend the disputes trigger).

4. **`members_decrypted` view exposes `anonymised_at`.** The migration `CREATE OR REPLACE`s `public.members_decrypted` re-derived byte-for-byte from its current definition (`20260513000003`) plus `m.anonymised_at` in the SELECT list. (Per the project rule: a new column on `members` is NOT auto-exposed by the explicit-projection view.) Re-grant `select` to `authenticated`.

5. **`anonymise_member(p_member_id uuid)` RPC.** The migration creates `public.anonymise_member(p_member_id uuid)` — `language plpgsql`, `security definer`, `set search_path = public, extensions, vault, pg_temp`. Returns a one-row result `(status text, member_id uuid)` where `status ∈ ('anonymised', 'already_anonymised', 'not_found')`. `grant execute` to `service_role` ONLY; `revoke` from `public` and `authenticated`.

### The anonymisation behaviour (the RPC)

6. **Not-found → `not_found`.** If no `members` row has `id = p_member_id`, the RPC returns `('not_found', p_member_id)` — it does NOT raise. (The Edge Function maps this to a 404-style response, not a 500.)

7. **Idempotent.** **Given** a member whose `anonymised_at` is already NOT NULL, the RPC returns `('already_anonymised', p_member_id)` and makes NO further change — no second Vault write, no second `members` UPDATE, no second audit event. (Mirrors `set_member_sms_opt_out`'s idempotent early-return.)

8. **PII fields replaced by salted hashes.** **When** `anonymise_member` runs on a non-anonymised member, **Then** the member's two Vault secrets are overwritten in place via `vault.update_secret`:
   - **name** secret ← `'SAVER_' || substr(encode(extensions.digest('name:' || v_collector_id::text || ':' || p_member_id::text, 'sha256'), 'hex'), 1, 12)` (e.g. `SAVER_a1b2c3d4e5f6`).
   - **phone** secret ← `encode(extensions.digest('phone:' || v_collector_id::text || ':' || p_member_id::text, 'sha256'), 'hex')` (the full 64-char hex).
   The hash inputs are **server-side identifiers only** (`collector_id`, `member_id`) — never the plaintext name/phone. After this, `members_decrypted.name` / `.phone_number` return the hash strings. `members.name_encrypted` / `phone_number_encrypted` (the `uuid` pointers) are UNCHANGED — only the secret *content* behind them is overwritten.

9. **Irreversible.** **Then** the original name/phone plaintext is unrecoverable: `vault.update_secret` re-encrypts the secret with the hash, destroying the prior content; and because the replacement hash is derived from non-PII identifiers there is nothing to brute-force. There is NO un-anonymise RPC.

10. **`members` row retained; PII columns + flags updated in ONE UPDATE.** **And** the `members` row is NOT deleted. A single `UPDATE public.members SET phone_number_hash = NULL, sms_opt_out = true, sms_opt_out_at = now(), sms_opt_out_via = 'anonymisation', anonymised_at = now(), updated_at = now() WHERE id = p_member_id AND anonymised_at IS NULL` is issued. `phone_number_hash` is cleared so the saver can no longer be located by phone lookup (`find_members_by_phone`). `members.status` is left UNCHANGED.

11. **`member.anonymised` audit event.** **And** the single `members` UPDATE fires the `audit_members` trigger → `audit_emit()` → the `anonymised_at` NULL→NOT NULL branch → exactly ONE `member.anonymised` row is appended to `audit_log`, hash-chained on the member's collector. The payload is `to_jsonb(new)` — it contains the encrypted-column UUIDs, NEVER plaintext PII.

12. **Transaction audit-chain integrity preserved.** **And** no `transactions` row and no existing `audit_log` row is modified or deleted. Every transaction referencing the saver keeps its `member_id` FK and its place in the hash chain; the chain still verifies end-to-end after anonymisation (only the member's PII changed, behind Vault — not the transactional data).

13. **No further SMS.** **And** `sms_opt_out = true` blocks all future enqueues (the existing SMS-enqueue path short-circuits on `members.sms_opt_out`), and any `sms_queue` rows currently `status = 'queued'` for this member's transactions are set to `status = 'abandoned', abandoned_at = now()` (the `set_member_sms_opt_out` cancellation pattern — reuse that exact UPDATE shape).

### The Edge Function

14. **`saver-delete` Edge Function.** `supabase/functions/saver-delete/index.ts` exports an async `handler(req)` and is registered with the `globalThis.Deno?.serve` guarded entry point (so a Deno test can `import` it without starting a server). `POST` only — any other method → an RFC 7807 `method_not_allowed`.

15. **Service-role-only.** The function rejects any request whose `Authorization: Bearer <token>` is not a **constant-time** match for `SUPABASE_SERVICE_ROLE_KEY` — reuse `constantTimeEquals` + `isServiceRole(req)` from `dispute-notify`. Failure → an RFC 7807 `auth_service_role_required` problem response. Register the function in `supabase/config.toml` with `verify_jwt = false` (the function does its own service-role check — mirror the `dispute-notify` config entry).

16. **Request contract.** Body is JSON `{ member_id: string (uuid), confirm: boolean }`. Invalid JSON → `request_invalid`. Missing/non-string `member_id`, or `member_id` not a UUID, or `confirm !== true` → an RFC 7807 `request_invalid` problem (`confirm` must be literally `true` — a deliberate guard against an accidental call). NEVER log `member_id` in full — log only a prefix (`member_id.slice(0, 8)`), consistent with `dispute-notify`'s PII-safe logging.

17. **Response.** On a valid request the function calls the `anonymise_member` RPC and returns `200 { ok: true, status }` where `status` is the RPC's `status` (`anonymised` | `already_anonymised` | `not_found`). An RPC/transport error → an RFC 7807 `internal_unexpected` (the function does not leak the DB error text). The function NEVER logs or returns plaintext name/phone.

### Tests + gates

18. **Deno tests.** `supabase/functions/saver-delete/index.test.ts` covers: (a) non-POST → `method_not_allowed`; (b) missing/wrong service-role key → `auth_service_role_required`; (c) bad body / missing `member_id` / `confirm !== true` → `request_invalid`; (d) unknown `member_id` → `200 { status: "not_found" }`; (e) **happy path** on a seeded member — `200 { status: "anonymised" }`, then assert via a service client: `members_decrypted.name` starts with `SAVER_`, `phone_number` is a 64-hex string, `anonymised_at` is NOT NULL, `sms_opt_out` is true, `sms_opt_out_via = 'anonymisation'`, `phone_number_hash` is NULL, exactly one `audit_log` row with `event_type = 'member.anonymised'` for the collector, and the member's transactions are unchanged; (f) **idempotency** — a second call → `200 { status: "already_anonymised" }` with no new audit row. Use `_shared/test-fixtures.ts` (`seedCollector`, `seedMemberWithCycle`, `cleanup`); env-gated/skip pattern as the sibling tests. The `saver-delete` test needs only `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (no Termii) — it runs clean locally.

19. **Migration smoke-tested.** The migration is applied locally with `npm run db:migrate` (NEVER `db:reset`) and `psql`-smoke-tested: `select anonymise_member('<seeded uuid>')` returns `anonymised`; a second call returns `already_anonymised`; the seeded member's `members_decrypted` row shows the `SAVER_` name + hashed phone + `anonymised_at`; exactly one `member.anonymised` `audit_log` row chained; an unmapped-event regression check confirms the rebased `audit_emit` still emits `member.created` on INSERT and `dispute.flagged` on a disputes INSERT (no branch dropped).

20. **No new dependency; layering respected.** No `package.json` change. All new code lives in `supabase/` (`migrations/`, `functions/saver-delete/`). No `src/` change. Brand-token / ESLint rules are not in play (no React code).

21. **All gates green** on Node 22 (`nvm use 22`): `npm run typecheck`, `npm run lint`, `npm run test` (vitest — confirm no regression; this story adds no vitest), `npm run build`, and `npm run test:edge` for the new `saver-delete` Deno tests (the pre-existing local `sms-inbound` / `sms-worker` Termii-secret failures are unrelated and expected). No Playwright E2E — Story 10.4 has no UI surface; the Deno tests + the psql smoke test are the behavioural gate.

## Tasks / Subtasks

- [x] **Task 1 — The migration: schema + CHECK** (AC: #1, #2)
  - [x] `npm run db:migrate:new saver-anonymisation` to create the migration file.
  - [x] `alter table public.members add column anonymised_at timestamptz null;`
  - [x] Drop the existing `sms_opt_out_via` CHECK (verify its name — `members_sms_opt_out_via_check`) and re-add it with `'anonymisation'` appended to the allowed set.
- [x] **Task 2 — The migration: `audit_emit()` rebase** (AC: #3)
  - [x] Copy the **entire** `audit_emit()` body from `20260516213715_dispute-resolved-audit.sql`.
  - [x] Insert the `member.anonymised` CASE line immediately before the generic `members`/`UPDATE` → `member.updated` line.
  - [x] Keep `set check_function_bodies = off;`, the `comment on function`, the `revoke execute … from public`. Do NOT touch the `audit_members` trigger (already `AFTER INSERT OR UPDATE OR DELETE`).
- [x] **Task 3 — The migration: `members_decrypted` view** (AC: #4)
  - [x] `CREATE OR REPLACE VIEW public.members_decrypted` re-derived from `20260513000003` + `m.anonymised_at`; keep `security_invoker = true`; re-`grant select … to authenticated`; update the view comment.
- [x] **Task 4 — The migration: `anonymise_member` RPC** (AC: #5–#13)
  - [x] `create or replace function public.anonymise_member(p_member_id uuid) returns table(status text, member_id uuid)` — `security definer`, `set search_path = public, extensions, vault, pg_temp`.
  - [x] Select `collector_id, name_encrypted, phone_number_encrypted, anonymised_at` into locals; not-found → return `('not_found', p_member_id)`; already-anonymised → return `('already_anonymised', p_member_id)`.
  - [x] Compute the two salted hashes (AC #8) from `collector_id` + `member_id`.
  - [x] `perform vault.update_secret(v_name_encrypted, v_name_hash);` and the same for the phone secret.
  - [x] The single `UPDATE public.members SET … WHERE id = p_member_id AND anonymised_at IS NULL` (AC #10).
  - [x] The `sms_queue` abandon UPDATE (AC #13 — copy the `set_member_sms_opt_out` shape).
  - [x] Return `('anonymised', p_member_id)`.
  - [x] `grant execute … to service_role`; `revoke … from public, authenticated`; `comment on function`.
- [x] **Task 5 — Apply + smoke-test the migration** (AC: #19)
  - [x] `nvm use 22 && npm run db:migrate`.
  - [x] `psql` smoke test per AC #19 — including the no-dropped-branch regression check on `audit_emit`.
- [x] **Task 6 — The `saver-delete` Edge Function** (AC: #14–#17)
  - [x] `supabase/functions/saver-delete/index.ts` — copy the `dispute-notify` shell: `constantTimeEquals`, `isServiceRole`, `logJson`, `problem`/`problemResponse`, the guarded `Deno.serve` entry.
  - [x] `handler`: POST-only; service-role gate; parse + validate `{ member_id, confirm }` (UUID check; `confirm === true`); call `service.rpc("anonymise_member", { p_member_id })`; map to `200 { ok, status }` or `internal_unexpected`. PII-safe logging (id prefix only).
  - [x] No `supabase/config.toml` change — `saver-delete` matches `dispute-notify` (which has no block): the service-role key is a valid JWT, passes the default `verify_jwt` platform gate, and the function's own `isServiceRole` constant-time check is the real boundary.
- [x] **Task 7 — Deno tests + gates** (AC: #18, #20, #21)
  - [x] `supabase/functions/saver-delete/index.test.ts` covering AC #18 (a)–(f).
  - [x] Run all gates on Node 22 (AC #21); `npm run test:edge` for the new function.
  - [x] Fill the Dev Agent Record (Debug Log, Completion Notes, File List) + the Change Log.

## Dev Notes

### Why hash server-side identifiers, not the plaintext PII

AC #8 derives the replacement hashes from `collector_id || member_id`, **not** from the saver's actual name/phone. This is deliberate and is the crux of FR48's "irreversible":

- A hash *of the plaintext phone* is **pseudonymisation, not anonymisation** — phone numbers have very low entropy (~10 digits) and the only "salt" available (`collector_id`) is stored in the same row, so it is not secret. Anyone with DB access could brute-force the phone back. That would defeat a right-to-deletion guarantee.
- Hashing `collector_id || member_id` produces a stable, unique, opaque token with **no PII input at all** — there is literally nothing to reverse. Combined with `vault.update_secret` destroying the original plaintext, the anonymisation is irreversible at two independent levels.
- The PRD's wording "salted phone hash" (`prd.md:282`) predates this analysis; the spec honours FR48's *intent* ("anonymising … while preserving the audit trail") over the literal phrase. Record this rationale in the Dev Agent Record.

### `vault.update_secret` vs. create-new-and-orphan

`members.name_encrypted` / `phone_number_encrypted` are `uuid` pointers into `vault.secrets`. Two ways to anonymise:
- ❌ `vault_encrypt(hash)` → a NEW secret, then overwrite the column. The OLD secret (with the real plaintext) is left **orphaned but intact** in `vault.secrets` — the plaintext survives. Not acceptable for a deletion request.
- ✅ `vault.update_secret(<existing secret_id>, <hash>)` — re-encrypts the secret content **in place**. The column UUID is unchanged; the plaintext is destroyed. No orphan rows.

Use `vault.update_secret`. It is part of `supabase_vault` (same extension as `vault.create_secret`, which `vault_encrypt` already calls). Because `anonymise_member` is `SECURITY DEFINER` owned by the migration role (as `vault_encrypt` is), it can call it. **Smoke-test this explicitly** in Task 5 — if the local Vault rejects `vault.update_secret` for any reason, fall back to `vault_encrypt`-new-secret **plus** `delete from vault.secrets where id = <old_id>` to destroy the orphan, and note the deviation.

### Why one combined `members` UPDATE — and no `set_member_sms_opt_out` call

`anonymise_member` does the PII-flag UPDATE itself rather than calling `set_member_sms_opt_out`:
- `set_member_sms_opt_out` issues its OWN `members` UPDATE → that would fire `audit_members` a second time → a spurious `member.updated` event on top of `member.anonymised`. A single combined UPDATE keeps the audit story to exactly ONE `member.anonymised` event.
- The opt-out is recorded *as part of* the anonymisation (`sms_opt_out_via = 'anonymisation'`), not as a separate `sms.opt_out` event — accurate provenance.
- Reuse only the **queued-SMS abandon UPDATE shape** from `set_member_sms_opt_out` (AC #13), not the whole RPC.

### The `audit_emit` rebase discipline (Stories 9.3 / 10.1 each hit this)

`CREATE OR REPLACE audit_emit()` MUST start from the **latest** migration that touched it — `20260516213715_dispute-resolved-audit.sql` — NOT an older one. Story 10.1 once rebased on a stale baseline and silently reverted the 2.5/3.3/4.5 patches; it was only caught by the full Playwright suite. The psql smoke test in Task 5 includes an explicit no-dropped-branch regression check. The new `member.anonymised` line goes BEFORE the generic `members`/`UPDATE` line (specific conditions first — same ordering rule as `cycle.settled` before `cycle.transitioned`, `dispute.resolved` before `dispute.updated`).

### `members.status` is intentionally left alone

The `members_status_enum` has a `deleted` value, and `delete_member` (Story 2.6) is a true hard-delete. Anonymisation is a *different* operation: the row lives on for audit continuity. Do NOT set `status = 'deleted'` — dashboard, members-list and cycle queries all branch on `status`, and flipping it would silently drop the member from those views (a regression outside this story's scope). `anonymised_at` is the sole marker; Story 10.5 will read it to gate its opt-out surface.

### Who calls `saver-delete`

The epic says "via receipt URL page action or **direct support**". No receipt-URL `/r/{token}/delete` route is wired by any story yet, so at MVP the function is invoked by **support / the founder** with the service-role key (e.g. `curl` / a Supabase dashboard call). The `confirm: true` body field is the deliberate "are you sure" guard. A saver-facing surface is explicitly a later story — do not build one here.

### Edge runtime + test env

The `saver-delete` Deno test needs only `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — no Termii secret — so it runs clean locally (unlike `sms-inbound`/`sms-worker`, whose pre-existing local `test:edge` failures are a Termii-secret gap and unrelated). Follow the env-gated skip pattern of `dispute-notify/index.test.ts`.

### Project Structure Notes

- New: `supabase/functions/saver-delete/index.ts` + `index.test.ts`; one `supabase/migrations/<timestamp>_saver-anonymisation.sql`; a `[functions.saver-delete]` block in `supabase/config.toml`.
- Modified by `CREATE OR REPLACE` (no new files): `audit_emit()`, `members_decrypted`.
- No `src/` change, no `package.json` change, no Cloudflare Worker change.
- Layering: the Edge Function is a thin transport/validation shell; ALL data mutation is in the `anonymise_member` RPC (consistent with Story 10.1's Worker → `flag_transaction_dispute` split).

### References

- **Epic spec:** `epics.md:1373-1388` (Story 10.4 BDD), `epics.md:184` (AR13), `epics.md:407` (Epic 10 coverage).
- **PRD:** `prd.md:544` (FR48 — right-to-deletion via anonymising name+phone with salted hashes, audit trail preserved), `prd.md:282` (retention policy — saver PII 2 years post-cycle or on deletion request; `SAVER_<hash>` convention; transaction record preserved via anonymisation).
- **Architecture:** `architecture.md:832-833` (`saver-delete/index.ts` — "POST — anonymises saver PII per FR48"), `architecture.md:1219` + `:1091` (FR48 → `supabase/functions/saver-delete/`), `architecture.md:115` (tiered retention — deletion triggers anonymisation, not hard delete), `architecture.md:674` (never log PII in plaintext).
- **Existing code — migrations:** `20260419000001_init_schema.sql` (`members` table, `pgcrypto`), `20260419000005_vault_setup.sql` (`vault_encrypt`/`vault_decrypt`, `name_encrypted`/`phone_number_encrypted`), `20260422000002_members_phone_uniqueness.sql` (`phone_number_hash` + the `digest`/`encode` idiom), `20260501000001_add_sms_opt_out_to_members.sql` (`sms_opt_out*` columns + the CHECK), `20260501000004_set_member_sms_opt_out.sql` (the idempotent-RPC + queued-SMS-abandon pattern), `20260513000003_members_decrypted_expose_sms_opt_out.sql` (the current `members_decrypted` view), `20260516213715_dispute-resolved-audit.sql` (the **current** `audit_emit()` — the rebase baseline), `20260419000003_audit_log.sql` (the `event_type` regex CHECK).
- **Existing code — Edge Functions:** `supabase/functions/dispute-notify/index.ts` (the service-role shell, `constantTimeEquals`, RFC 7807, `logJson`, the guarded `Deno.serve`), `supabase/functions/_shared/rfc7807.ts`, `supabase/functions/_shared/test-fixtures.ts`, `supabase/functions/dispute-notify/index.test.ts` (the env-gated Deno test pattern), `supabase/config.toml` (the per-function `verify_jwt` config).
- **Previous story:** `10-3-dispute-member-profile-banner.md` (the `audit_emit` rebase discipline; the migration psql-smoke-test discipline).
- **CLAUDE.md:** `db:migrate` not `db:reset`; views are explicit projections (update them when adding columns); no new deps for trivial needs.
- **Memory:** `feedback_migration_rpc_smoke_test.md` (psql-smoke-test RPC migrations — TS gates miss Postgres-side type errors), `project_views_after_columns.md` (new columns are NOT auto-exposed by `members_decrypted`), `feedback_npm_lockfile_node_version.md` / `feedback_run_coverage_locally.md` (Node 22; gates locally before push).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **`config.toml` — no `[functions.saver-delete]` block needed (deviation from AC #15's `verify_jwt = false`).** AC #15 specified registering the function with `verify_jwt = false`. The actual sibling template `dispute-notify` has NO `config.toml` block at all — it relies on the default `verify_jwt = true`: the service-role key IS a valid JWT, so it passes the platform gate, and the function's own `constantTimeEquals` / `isServiceRole` check is the real boundary. `saver-delete` is invoked the same way (service-role key as `Authorization: Bearer`). Matching `dispute-notify` exactly (no block) is cleaner than the spec's guess and is proven to work. No `config.toml` change shipped.
- **`vault.update_secret` confirmed working.** The psql smoke test verified `vault.update_secret(secret_id, hash)` overwrites the secret content in place — `vault_decrypt` then returns the hash, the `*_encrypted` uuid pointers unchanged. No fallback (create-new + delete-orphan) needed.
- **`node_modules` / `deno.lock` pollution.** The Deno `--node-modules-dir=auto` runs repopulate `node_modules/.deno/` (breaks vitest) and rewrite `deno.lock` with unrelated churn (a stale `@tanstack/react-query` bump from another concern). Restored `node_modules` via `npm ci` before the vitest gate; reverted `deno.lock` (Story 10.4 adds zero new Deno deps — `saver-delete` reuses `dispute-notify`'s exact imports).

### Completion Notes List

- **Migration `20260516225824_saver-anonymisation.sql`** — adds `members.anonymised_at`; extends the `members_sms_opt_out_via_check` CHECK with `'anonymisation'`; `CREATE OR REPLACE`s `audit_emit()` (rebased on `20260516213715` — every prior branch preserved; ONE new `(members, UPDATE)` `member.anonymised` line, `anonymised_at` NULL→NOT NULL, placed before the generic `member.updated`); `CREATE OR REPLACE`s `members_decrypted` (+ `anonymised_at`); creates `anonymise_member(p_member_id uuid)` SECURITY DEFINER, `service_role`-only. The `audit_members` trigger already fires `AFTER INSERT OR UPDATE OR DELETE` — no trigger change.
- **`anonymise_member` RPC** — not-found-safe (`status = 'not_found'`, no raise); idempotent (`already_anonymised` early-return); derives the two replacement hashes from `collector_id || member_id` (server-side identifiers — irreversible by construction, no PII input); `vault.update_secret` overwrites the name/phone secrets in place; ONE `members` UPDATE (`phone_number_hash` NULL, `sms_opt_out` true, `sms_opt_out_via = 'anonymisation'`, `anonymised_at = now()`) drives a single `member.anonymised` audit event; abandons queued `sms_queue` rows. `members.status` left unchanged.
- **`saver-delete` Edge Function** (`supabase/functions/saver-delete/index.ts`) — POST-only; constant-time service-role gate (the `dispute-notify` shell); body `{ member_id (uuid), confirm: true }`; calls `anonymise_member`; returns `200 { ok, status }` or an RFC 7807 problem; PII-safe logging (id prefix only).
- **psql smoke test** — `anonymise_member` 1st call → `anonymised` (name `SAVER_0cda561f9473`, phone a 64-hex hash, `phone_number_hash` NULL, `sms_opt_out`/`via` set, `anonymised_at` stamped, `status` unchanged `active`, a `member.anonymised` event chained); 2nd call → `already_anonymised` with still exactly 1 event; unknown id → `not_found`. Transaction-isolated (`begin`/`rollback`) — the seeded member was verified untouched after.
- **Gates** (Node 22): typecheck ✓ · lint --max-warnings=0 ✓ · 986 vitest passed / 1 skipped (no `src/` change — no regression) ✓ · build ✓ · `test:edge` — the 7 new `saver-delete` Deno tests green within the full run (181 passed; the 11 failures are exclusively the pre-existing local `sms-inbound`/`sms-worker` Termii-secret gap — unrelated, fail identically on clean `main`). No Playwright (no UI surface).

### File List

**New:**
- `supabase/migrations/20260516225824_saver-anonymisation.sql`
- `supabase/functions/saver-delete/index.ts`
- `supabase/functions/saver-delete/index.test.ts`

**Modified:**
- `scripts/run-edge-tests.sh` — registers `saver-delete/index.test.ts` in the Deno test runner.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-17 | Story 10.4 implemented via bmad-dev-story on `feat/10-4-saver-anonymisation-edge-function` — 7 tasks / 21 ACs. ONE migration `20260516225824_saver-anonymisation.sql`: `members.anonymised_at` + the `sms_opt_out_via` CHECK extended with `'anonymisation'` + `audit_emit()` rebased on `20260516213715` (a new `(members, UPDATE)` `member.anonymised` branch — `anonymised_at` NULL→NOT NULL — all prior branches preserved) + `members_decrypted` exposes `anonymised_at` + the `anonymise_member(p_member_id)` SECURITY DEFINER RPC. NEW `saver-delete` Edge Function (service-role-only `POST /functions/v1/saver-delete` `{member_id, confirm}` — the `dispute-notify` shell — delegates to `anonymise_member`). The RPC overwrites the name/phone Vault secrets in place via `vault.update_secret` with hashes derived from `collector_id||member_id` (irreversible by construction), clears `phone_number_hash`, sets `sms_opt_out` (`via='anonymisation'`), stamps `anonymised_at`, abandons queued SMS — one `members` UPDATE chains `member.anonymised`. Idempotent + not-found-safe; transactions + the audit hash-chain untouched. Debug: no `config.toml` block (matches `dispute-notify` — the service-role key passes the default platform JWT gate; deviation from AC #15's `verify_jwt=false`). Gates green: typecheck / lint / 986 vitest (no regression) / build / `test:edge` 7 new `saver-delete` tests green (the 11 sms-inbound/sms-worker failures are the pre-existing local Termii-secret gap). | Dev agent (claude-opus-4-7[1m]) |
| 2026-05-17 | Story 10.4 drafted via bmad-create-story — FOURTH story of Epic 10 (Saver Dispute Flow & Data Rights). The right-to-deletion as **anonymisation**: a new `saver-delete` Edge Function (AR13) — service-role-only `POST /functions/v1/saver-delete` `{ member_id, confirm }` — delegates to a new `anonymise_member(p_member_id)` SECURITY DEFINER RPC. The RPC overwrites the member's two Vault secrets in place via `vault.update_secret` with salted hashes derived from `collector_id || member_id` (NOT the plaintext PII — genuine irreversibility), clears `phone_number_hash`, sets `sms_opt_out` (`via = 'anonymisation'`), stamps `anonymised_at`, and abandons queued SMS — one `members` UPDATE drives a new `audit_emit()` `member.anonymised` branch. Transactions + the audit hash-chain are untouched. ONE migration: `members.anonymised_at` + the `sms_opt_out_via` CHECK + the `audit_emit` rebase + the `members_decrypted` view + the RPC. NO `src/` change, NO new npm dependency, NO UI surface (support-invoked at MVP). 21 ACs / 7 tasks. | Spec author (claude-opus-4-7[1m]) |

## Review Findings

**Reviewed:** 2026-05-17 · `bmad-code-review` · 3-layer adversarial (Blind Hunter / Edge Case Hunter / Acceptance Auditor, sonnet-4-6) on the staged diff of `feat/10-4-saver-anonymisation-edge-function` (6 files, +880/−2).

**Verdict:** APPROVE WITH PATCHES. No Critical / High defects confirmed. The `audit_emit()` rebase is byte-for-byte clean — every prior branch preserved (2.5 actor-JWT, 3.3 `cycle.transitioned`, 4.5 `transaction.undone`, 10.1 `dispute.flagged`, 10.3 `dispute.resolved`/`dispute.updated`); the `member.anonymised` CASE is correctly ordered before the generic `member.updated`. The `sms_opt_out_via` CHECK swap is sound. No plaintext PII reaches the audit payload. 5 patches (Low/Medium), 2 deferrals, the rest dismissed.

### Patches to apply (P1–P5)

- [x] [Review][Patch] **P1 — `anonymise_member`: lock the row so the idempotency guard is correct under concurrency (Medium)** [`supabase/migrations/20260516225824_saver-anonymisation.sql`]. The `SELECT … INTO` has no `FOR UPDATE`. Two concurrent calls both pass the `anonymised_at IS NULL` guard, both call `vault.update_secret` (same deterministic hash — harmless), then both run the `UPDATE … WHERE anonymised_at IS NULL` — the loser matches 0 rows (correct: one audit event) but still `return query select 'anonymised'`, a misleading status. Fix: add `for update` to the `SELECT … INTO` — the second call then blocks, reads `anonymised_at IS NOT NULL`, and correctly returns `already_anonymised`. (The "half-anonymised state on UPDATE failure" the Blind Hunter raised is a false alarm — the plpgsql function body is one transaction; an exception rolls back the Vault writes too.)
- [x] [Review][Patch] **P2 — `saver-delete`: an unexpected empty RPC result should be a 500, not a fake `not_found` (Low)** [`supabase/functions/saver-delete/index.ts`]. `const status = (row?.status ?? "not_found")` — `anonymise_member` always `return query select`s a row, so a null/empty `data` means a broken contract; silently returning `200 { status: "not_found" }` masks it. Fix: if `data` has no row, return `internal_unexpected`.
- [x] [Review][Patch] **P3 — add a wrong-bearer test (AC #18b) (Medium)** [`supabase/functions/saver-delete/index.test.ts`]. The "missing service-role bearer → 403" test only sends `null` (no `Authorization` header) — the `constantTimeEquals` path for a present-but-wrong key is untested. AC #18(b) requires "missing/**wrong**". Fix: add a case with `env.anonKey` as the bearer asserting 403.
- [x] [Review][Patch] **P4 — assert the queued-SMS abandon in the happy-path test (AC #13) (Low)** [`supabase/functions/saver-delete/index.test.ts`]. The happy-path test seeds a contribution but never asserts AC #13's "no further SMS" outcome. Fix: after anonymisation, assert no `sms_queue` row for the member's transactions is left in `status = 'queued'`.
- [x] [Review][Patch] **P5 — fix the misleading Task 6 `config.toml` subtask checkbox (Low)** [`10-4-saver-anonymisation-edge-function.md`]. Task 6 has `[x] Add the [functions.saver-delete] entry to supabase/config.toml` — but no block was added (a deliberate, documented deviation: `saver-delete` matches `dispute-notify`, which has no block; the service-role key passes the default `verify_jwt` gate and `isServiceRole` is the real boundary). Fix: rewrite that subtask line to state no block is needed, so the checklist isn't misleading.

### Deferred (pre-existing — not caused by this change)

- [x] [Review][Defer] **`members_decrypted` does not expose `sms_opt_out_at` / `sms_opt_out_via`** [`supabase/migrations/20260516225824_saver-anonymisation.sql`] — deferred, pre-existing. Those columns were never exposed (only `sms_opt_out` was, in `20260513000003`); the view re-derivation faithfully reproduces the prior projection + `anonymised_at`. If Story 10.5 needs `sms_opt_out_via` it can expose it then.
- [x] [Review][Defer] **`set_member_sms_opt_out`'s internal `p_via` allowlist is stale vs the column CHECK** [`supabase/migrations/20260501000004_set_member_sms_opt_out.sql`] — deferred, pre-existing. The column CHECK now allows `'anonymisation'` but the RPC's `p_via not in (…)` guard does not. No active caller passes `'anonymisation'` to that RPC (`anonymise_member` does its own UPDATE), so it is only a forward-compat staleness — a follow-on migration can sync the guard.

### Dismissed (8)

The `config.toml` deviation itself (sound, documented, matches `dispute-notify` — Edge Hunter marked it clean); re-enrollment of an anonymised saver's phone now possible (by design — the saver exercised deletion, re-adding is legitimate); `find_members_by_phone` could match the 64-hex hash literal (not exploitable — the real phone no longer decrypts to a match); the `vault.update_secret` extension-availability risk (proven working by the psql smoke test AND the persisted Deno happy-path run); the `collector_id IS NULL` not-found idiom (correct — `collector_id` is `NOT NULL`); the `isServiceRole` empty-env edge case (Blind Hunter concluded the logic is correct); `to_jsonb(old)` recomputed per CASE branch (pre-existing micro-nit across the whole function, not introduced here); the audit-log test not filtering by `collector_id` (`entity_id` is a per-run random UUID — already collision-free).

### Patch Resolution — 2026-05-17

All 5 patches (P1–P5) applied:

- **P1** — `anonymise_member`: `for update` added to the `SELECT … INTO` — a concurrent second call now blocks, reads `anonymised_at` as NOT NULL, and correctly returns `already_anonymised` (no double Vault write, no misleading status).
- **P2** — `saver-delete/index.ts`: a null/empty RPC result now returns `internal_unexpected` (500) instead of a fake `200 { status: "not_found" }`.
- **P3** — `index.test.ts`: new "wrong service-role bearer (anon key) → 403" test exercises the `constantTimeEquals` path (AC #18b).
- **P4** — `index.test.ts`: the happy-path test now asserts no `sms_queue` row for the member's transaction is left `queued` after anonymisation (AC #13).
- **P5** — story file: the Task 6 `config.toml` subtask rewritten to state no block is needed (matches `dispute-notify`).

D1/D2 deferred to `deferred-work.md` (pre-existing, not 10.4 defects).

**Gates re-run (Node 22):** typecheck ✓ · lint --max-warnings=0 ✓ · 986 vitest passed ✓ · build ✓ · the patched migration re-smoke-tested (psql, `begin/rollback`) — `anonymised` / `already_anonymised` / `not_found` all correct after the `for update` change · 8 `saver-delete` Deno tests green (was 7 — +1 wrong-bearer). Story status → `done`.
