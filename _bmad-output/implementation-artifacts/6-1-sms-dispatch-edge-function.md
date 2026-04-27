# Story 6.1: SMS dispatch Edge Function (operates on `sms_queue` created in Story 1.2)

Status: ready-for-dev

## Story

As a **developer**,
I want **a durable SMS commitment pattern implemented as a dispatch Edge Function that enqueues receipts into the `sms_queue` table created in Story 1.2**,
so that **no transaction's SMS is ever lost to a transient SMS gateway failure (AR9, FR27, NFR-R4).**

> **Predicate of this story.** Story 1.2 shipped the `sms_queue` table + RLS policies. Story 4.3 shipped the AFTER INSERT `enqueue_sms_on_transaction` trigger that fires on contribution / rattrapage / advance commits, inserts a row with a STUB body (`'[STUB] Transaction enregistrée'`), and respects the cash-only-saver skip. Story 4.5 flipped the `sms_queue.transaction_id` FK from `CASCADE` to `SET NULL`. Story 6.1 closes the durable-commitment loop: extends the schema with `template_key` + retry/abandonment columns (BDD line 966), patches the trigger to populate them, and ships the manual-resend Edge Function `/functions/v1/sms-dispatch`. **What Story 6.1 does NOT ship**: the actual SMS template rendering (Story 6.3 owns the copy), the worker that drains the queue + calls Termii (Story 6.2), the saver-facing receipt URL (Story 6.4), the consent / opt-out mechanism (Story 6.5).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 961-967; the rest are spec-derived constraints required for a flawless implementation.

1. **Schema — new `template_key` column on `sms_queue`.** New migration `20260427000003_extend_sms_queue_for_dispatch.sql`:
   - `ALTER TABLE public.sms_queue ADD COLUMN template_key text NULL;` (NULL initially so the migration can land before the trigger update; the trigger will start populating it; a follow-up `SET NOT NULL` lands AFTER existing rows are backfilled — see AC #2 ordering note).
   - **Allowed values** (enforced via CHECK constraint): `'first_receipt'`, `'subsequent_receipt'`, `'settlement'`, `'dispute_ack'`. The 4 keys map to Story 6.3's templates. Story 6.1 only writes the first 2 (transaction commits); Story 7.5 will write `'settlement'`; Story 10.2 will write `'dispute_ack'`.
   - `ALTER TABLE public.sms_queue ADD CONSTRAINT sms_queue_template_key_chk CHECK (template_key IN ('first_receipt', 'subsequent_receipt', 'settlement', 'dispute_ack'));` (constraint is `NOT VALID` initially so existing STUB rows from Story 4.3's trigger don't fail — Story 6.1's same migration backfills them then `VALIDATE`s).

2. **Schema — `retry_count`, `next_retry_at`, `abandoned_at` columns** (BDD line 966):
   - `retry_count int NOT NULL DEFAULT 0 CHECK (retry_count >= 0)`. The existing `attempts` column (added by migration 0001) is **deprecated** by this story. Story 6.1 does NOT drop it — a future cleanup migration can — but Stories 6.2 / 6.3 / future code MUST use `retry_count` exclusively. Document the deprecation in the column comment + the trigger migration.
   - `next_retry_at timestamptz NULL`. NULL = ready to drain immediately. Story 6.2 will set this on each Termii failure to schedule the exponential-backoff retry.
   - `abandoned_at timestamptz NULL`. NULL = still active. Story 6.2 will set this when the row is given up on (24 h continuous failure per architecture.md:643).
   - Index added: `CREATE INDEX idx_sms_queue_drain_ready ON public.sms_queue (status, next_retry_at NULLS FIRST, created_at) WHERE status = 'queued' AND abandoned_at IS NULL;` — the Story 6.2 worker's drain query is `WHERE status='queued' AND abandoned_at IS NULL AND (next_retry_at IS NULL OR next_retry_at <= now()) ORDER BY ...`. The `NULLS FIRST` ordering ensures fresh rows (no scheduled retry) are picked before previously-failed rows.

3. **Migration backfill for existing rows.** Same migration:
   - `UPDATE public.sms_queue SET template_key = 'first_receipt' WHERE template_key IS NULL;` — rough-and-ready: existing STUB rows from Story 4.3's trigger get mapped to `first_receipt` (the conservative choice that includes consent disclosure). Pre-prod local dev only; CI starts from a clean stack so this UPDATE is a no-op there.
   - `ALTER TABLE public.sms_queue ALTER COLUMN template_key SET NOT NULL;` (after the backfill).
   - `ALTER TABLE public.sms_queue VALIDATE CONSTRAINT sms_queue_template_key_chk;` (validate after backfill).

4. **Trigger function rewrite** — `enqueue_sms_on_transaction` (Story 4.3's function). Migration `20260427000004_enqueue_sms_template_key.sql`:
   - `CREATE OR REPLACE FUNCTION public.enqueue_sms_on_transaction()` — same signature, same SECURITY DEFINER + search_path.
   - **New behaviour:**
     - Determine `v_template_key`:
       - `'first_receipt'` if NO prior `sms_queue` row exists for any transaction belonging to `NEW.member_id` (i.e., this is the saver's first SMS — Story 6.5 will refine this with a `members.first_sms_sent_at` flag).
       - `'subsequent_receipt'` otherwise.
     - Body remains the existing `'[STUB] Transaction enregistrée'` literal — Story 6.3 will replace the trigger with one that renders the real template using a `format_sms_body(template_key, transaction_id)` SQL function. Story 6.1 explicitly does NOT do template rendering.
     - INSERT INTO `sms_queue` (collector_id, transaction_id, recipient_phone, body, status, template_key, retry_count) — the 3 new columns explicitly named; `retry_count` defaults to 0 via the column default; `next_retry_at` and `abandoned_at` stay NULL.
   - **Trigger ordering UNCHANGED** (still the AFTER INSERT order documented in Story 4.3 / 4.4 / 5.4 migrations): closed-cycle check → INSERT → audit → enqueue_sms → promote_cycle.
   - Comment cites BDD lines 961-967 + Story 4.3 (the function this replaces) + Story 6.3 (the next replacement that will render the real template).

5. **Edge Function `/functions/v1/sms-dispatch`** at `supabase/functions/sms-dispatch/index.ts`:
   - **Method:** `POST` only — any other method returns `405 Method Not Allowed`.
   - **Auth:** Bearer JWT in `Authorization` header. Use the existing `_shared/auth-check.ts` helper to extract `user_id`. Reject with `401 RFC 7807` if missing/invalid.
   - **Body:** JSON `{ "transaction_id": "<uuid>" }`. Zod-validated at the entry point (importing `zod` from JSR). Invalid → `400 RFC 7807` with the validation error.
   - **Logic:**
     1. SELECT `transactions` row where `id = body.transaction_id` AND `collector_id = jwt.sub`. Not found / RLS-rejected → `404 RFC 7807`.
     2. SELECT existing `sms_queue` rows for this transaction_id to detect "is this the saver's first?" (same logic as the trigger's template_key choice).
     3. INSERT a NEW `sms_queue` row identical to what the trigger would emit (template_key derived; recipient_phone resolved via `vault_decrypt(members.phone_number_encrypted)`; status `'queued'`; retry_count 0).
     4. Return `200 { "queue_id": "<uuid>" }`.
   - **Use case** (BDD line 967 — "manually enqueue, e.g. for re-send scenarios"): a future support flow where the collector taps "Renvoyer le reçu" on a member's transaction history (Story 6.6 ships that UI). For Story 6.1 it's an API-callable surface only; no UI consumer yet.
   - **Errors:** RFC 7807 across the board (consistent with re-auth Edge Function pattern from Story 1.3).
   - **Logging:** structured JSON via `console.log` per architecture.md § Logging conventions. NEVER log the SMS body, recipient_phone, or any plaintext PII.

6. **Re-auth NOT required for sms-dispatch.** A re-send is not a sensitive operation per FR5 (the destinations the collector chooses are bounded by their owned transactions). Audit the call via `audit_log` (a new event type `sms.queued` — see AC #7) so support flows are traceable.

7. **Audit event `sms.queued`.** The trigger function does NOT emit an audit event (it's a system-triggered path; the `transaction.committed` event from the audit_emit chain already covers the commit). The **manual** sms-dispatch Edge Function path DOES emit `sms.queued` so support / re-send actions are traceable — INSERT into `audit_log` from the Edge Function with:
   - `event_type = 'sms.queued'`
   - `entity_id = <new sms_queue.id>`
   - `entity_table = 'sms_queue'`
   - `payload = { transaction_id, template_key, recipient_phone_hash }` (NEVER the plaintext phone — hash via `digest(phone, 'sha256')`)
   - `actor = jwt.sub` (collector)
   - `source = 'online'`
   - **Hash chain**: the Edge Function calls a NEW `public.append_audit_event(...)` helper RPC (Story 6.1 ships this — SECURITY DEFINER, mirrors the audit_emit canonical-serialisation logic but for an "external" event without an underlying table UPDATE). Or (simpler) the Edge Function directly INSERTs into audit_log with prev_hash + entry_hash computed via the same canonical serialiser. **Pick one approach** in the implementation. **Recommended**: a new SQL helper `audit_append_external(p_event_type, p_entity_id, p_entity_table, p_payload)` returns the new event_id; mirrors the existing audit_emit serialiser logic.

8. **`recipient_phone` precedence.** When the saver has opted out (Story 6.5's eventual `members.sms_opt_out` flag) the trigger AND the Edge Function MUST skip the enqueue silently. **Story 6.5 ships the column + flag**; Story 6.1 includes a placeholder check (`IF NOT FALSE THEN ... END IF`) with a comment marking the spot for Story 6.5's wire-in. Documents the handshake without introducing the column prematurely.

9. **`transaction_id` referential integrity.** Existing FK is `ON DELETE SET NULL` (Story 4.5's flip). The Edge Function does NOT need to revalidate — if the row is undone (Story 4.5 soft-undo) the SMS row remains for forensics with `transaction_id` non-NULL but transactions.undone_at populated. The worker (Story 6.2) is responsible for skipping rows whose underlying transaction was undone (`transactions.undone_at IS NOT NULL`); Story 6.1 does NOT add that worker-side filter — it's Story 6.2's territory. Document this handshake in Dev Notes.

10. **No template rendering, no Termii call, no worker drain.** Story 6.1 explicitly ships **schema + trigger + manual-enqueue Edge Function**. Story 6.2 ships the worker + Termii integration. Story 6.3 ships the templates. Story 6.4 ships the receipt URL Cloudflare Worker. Each downstream story is independently testable.

11. **No new dependencies.** Termii client (Story 1.3) is reused but not invoked yet — Story 6.2 wires it. Zod is already in the deps. JSR `zod` for the Edge Function may need a small version-pin update but no new package.

12. **i18n keys.** No new keys — Story 6.1 is a backend-only story. Story 6.6 will add UI keys when the resend button surfaces.

13. **Tests — DB contract (Deno).** New `supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts`:
    - Insert a `transactions` row (via service-role bypassing the trigger's auth gate) for a member with phone → assert sms_queue row has `template_key='first_receipt'`, `retry_count=0`, `next_retry_at IS NULL`, `abandoned_at IS NULL`, `status='queued'`.
    - Insert a SECOND transaction for the same member → assert `template_key='subsequent_receipt'`.
    - Insert a transaction for a member WITHOUT a phone → assert NO sms_queue row.
    - DB CHECK constraint: direct UPDATE of an existing row's `template_key` to `'invalid_template'` → 23514 rejection.
    - DB CHECK constraint: direct INSERT with `retry_count = -1` → CHECK violation.

14. **Tests — Edge Function contract (Deno).** New `supabase/functions/sms-dispatch/index.test.ts`:
    - **Happy path:** authenticated collector POSTs `{transaction_id}` for own transaction → 200 + new sms_queue row + audit_log `sms.queued` event lands with hash-chain integrity.
    - **Foreign collector:** POST another collector's transaction_id → 404 RFC 7807 (RLS hides the row).
    - **Missing JWT:** no Authorization header → 401 RFC 7807.
    - **Wrong method (GET):** → 405 RFC 7807.
    - **Malformed body:** missing transaction_id → 400 RFC 7807.
    - **Unknown transaction_id:** valid uuid that doesn't exist → 404.
    - **Re-send creates a NEW row** (not idempotent — caller's responsibility to dedupe). Asserts that 2 calls produce 2 rows for the same transaction_id.
    - **Cash-only saver** (no phone): 200 + ZERO sms_queue rows inserted (silent skip mirrors the trigger).
    - Add the new test files to `scripts/run-edge-tests.sh`.

15. **Tests — vitest.** No client-side tests — Story 6.1 has no client surface. Story 6.6's resend UI will land its own tests.

16. **All gates green.**
    - `npm run db:migrate` — applies 2 new migrations.
    - `npm run db:types` — regenerates `database.types.ts` so `template_key` etc. land in the typed surface (Story 6.6's UI consumer will need them).
    - `npm run typecheck` / `npm run lint` / `npm test -- --coverage` / `npm run test:edge` / `npm run build` — all green.
    - Domain still 100 %; new edge tests join the existing 52 → 60+.
    - `npx playwright test` — UNCHANGED. No new E2E (Story 6.2 will add a dispatch-loop E2E).

## Tasks / Subtasks

- [ ] **Task 0 — Schema migration A (AC #1 #2 #3).** Create `20260427000003_extend_sms_queue_for_dispatch.sql`. Adds `template_key`, `retry_count`, `next_retry_at`, `abandoned_at` + CHECK constraint + drain index. Backfill existing rows.

- [ ] **Task 1 — Trigger replacement migration B (AC #4).** Create `20260427000004_enqueue_sms_template_key.sql`. Replaces `enqueue_sms_on_transaction` to populate `template_key` + new columns. Comment cites the Story 6.3 hand-off.

- [ ] **Task 2 — `audit_append_external` SQL helper (AC #7).** Create `20260427000005_audit_append_external.sql`. SECURITY DEFINER function mirroring `audit_emit`'s canonical serialiser; takes `(p_event_type text, p_entity_id uuid, p_entity_table text, p_payload jsonb)` + reads `auth.uid()` for actor. Returns `audit_log.event_id`. GRANT EXECUTE TO authenticated.

- [ ] **Task 3 — Regenerate types.** `npm run db:types` after migrations apply.

- [ ] **Task 4 — Edge Function `sms-dispatch` (AC #5 #6 #7 #8 #9).** Create `supabase/functions/sms-dispatch/index.ts`. POST-only, JWT-authenticated, Zod-validated body, RLS-respecting transaction lookup, RFC 7807 errors, structured JSON logging. Calls `audit_append_external` for the `sms.queued` event.

- [ ] **Task 5 — Trigger contract test (AC #13).** New `supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts`. ≥ 5 cases.

- [ ] **Task 6 — Edge Function contract test (AC #14).** New `supabase/functions/sms-dispatch/index.test.ts`. ≥ 8 cases. Add path to `scripts/run-edge-tests.sh`.

- [ ] **Task 7 — All gates (AC #16).** `db:migrate` / `db:types` / `typecheck` / `lint` / `test --coverage` / `test:edge` / `build`. No Playwright change.

- [ ] **Task 8 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `6-1-sms-dispatch-edge-function: backlog → ready-for-dev` (handled by `bmad-create-story` on save) → after dev: `→ review`.
  - **First story of Epic 6** — flip `epic-6: backlog → in-progress`.
  - Document the deprecation of `sms_queue.attempts` (replaced by `retry_count`) for a future cleanup migration.
  - Document the Story 6.5 / 6.2 / 6.3 / 6.4 hand-offs explicitly.

## Dev Notes

### Architecture compliance

- **Layering.** Pure SQL + Edge Function. No `src/` changes. The `_shared/termii-client.ts` (Story 1.3) is NOT invoked — Story 6.2 wires the actual delivery. The `_shared/auth-check.ts` + `_shared/rfc7807.ts` helpers are reused by the new Edge Function for consistency with the Story 1.3 / 4.3 patterns.
- **Cite sources.** Each migration + Edge Function header references BDD lines 961-967 + the Story-Xxx handshake.
- **Defence-in-depth on template_key.** Triple-gated: trigger picks one of 4 valid keys; `audit_append_external` doesn't accept template_key as input; DB CHECK rejects unknown values.
- **No frontend changes.** Story 6.1 is purely backend / infrastructure.

### Why a separate `audit_append_external` helper

The existing `audit_emit` trigger function is bound to AFTER INSERT/UPDATE/DELETE on a row of `members` / `cycles` / `transactions`. The `sms.queued` event is **not** tied to a row write on those tables — it's an explicit "the support flow re-enqueued an SMS" action. Two clean options:

1. **Add an AFTER INSERT trigger on sms_queue** that fires for every row (manual or auto) — but then we'd need a way to distinguish trigger-driven vs manual inserts (the audit chain would emit `sms.queued` on EVERY trigger insert, including the automatic transaction-commit path, which doubles the audit volume). Bad.
2. **A new SECURITY DEFINER RPC** the Edge Function calls explicitly. Good — explicit is better than implicit; the chain captures what the support flow did, not what the trigger did automatically.

Option 2 wins. Mirrors the `emit_session_event` Story 1.7 pattern.

### Why `template_key` instead of pre-rendered body

Three reasons:
1. **Story 6.3 owns the copy.** Pre-rendering at trigger time would force Story 6.3 to be a SQL-only refactor (rewriting the trigger function with embedded i18n strings). Storing only the `template_key` lets the worker (Story 6.2) call a `format_sms_body(template_key, transaction_id)` function (or direct rendering in TypeScript at the Termii client layer) at dispatch time — language pivots, copy edits, and A/B variants stay decoupled from the schema.
2. **Receipt URL token timing.** The receipt URL (Story 6.4) requires a token that may not exist at trigger time (depending on Story 6.4's choice of token storage). Deferring the body render to Story 6.2 lets the worker fetch all needed context (transaction amount, projected balance, receipt token) from the live database in one query.
3. **Re-send fidelity.** When Story 6.6's resend button calls `sms-dispatch`, the new row's `template_key` reflects the CURRENT state ("subsequent" because the saver has received SMS before). If we stored a pre-rendered body, the re-send would replay stale copy.

The cost: an extra `format_sms_body` step in Story 6.2/6.3. The benefit: a clean separation of concerns + Story 6.5 opt-out + Story 6.4 receipt URL slot.

### Why no template rendering in the body field

The existing `body text NOT NULL` constraint forces SOMETHING in that column. Story 6.1 keeps the existing STUB literal `'[STUB] Transaction enregistrée'` until Story 6.3 / 6.2 lands. Once the worker (Story 6.2) renders the body at dispatch time, it can either:
- UPDATE the row's `body` field with the rendered text (canonical record of what was sent), then call Termii.
- OR keep `body` as the STUB and use a separate `dispatched_body` column.

Story 6.1 doesn't choose — Story 6.2 will. The schema accommodates either.

### Story 6.5 handshake — opt-out check

BDD AC #8 above documents the placeholder. Story 6.5 will:
1. Add `members.sms_opt_out boolean NOT NULL DEFAULT false`.
2. Patch the trigger function to check `IF v_member.sms_opt_out THEN RETURN NULL; END IF;` BEFORE the INSERT.
3. Patch the sms-dispatch Edge Function with the same check (return 200 + `{ skipped: true, reason: 'opted_out' }`).

Story 6.1 ships the structural slot (a `IF FALSE THEN ... END IF;` block in the trigger with a `-- Story 6.5 will replace FALSE with v_member.sms_opt_out` comment). When Story 6.5 lands, only the boolean expression changes — the trigger structure stays.

### Story 6.2 handshake — drain query

The drain query Story 6.2 will run:

```sql
SELECT * FROM sms_queue
WHERE status = 'queued'
  AND abandoned_at IS NULL
  AND (next_retry_at IS NULL OR next_retry_at <= now())
ORDER BY next_retry_at NULLS FIRST, created_at
LIMIT 100;
```

Story 6.1's index `idx_sms_queue_drain_ready` is partial + ordered to match this query. Story 6.2 will additionally filter on `EXISTS (SELECT 1 FROM transactions WHERE id = sms_queue.transaction_id AND undone_at IS NULL)` to skip undone transactions (Story 4.5 soft-undo coordination).

### Anti-patterns (do NOT do)

- **Do NOT** drop the `attempts` column in Story 6.1. Defer to a cleanup migration (low priority — `attempts` is dead code post-6.1 but harmless).
- **Do NOT** render SMS templates in the trigger function. Defer to Story 6.3 / 6.2.
- **Do NOT** call Termii from Story 6.1 — that's Story 6.2's territory.
- **Do NOT** add receipt URL token generation in Story 6.1 — defer to Story 6.4 (which may add a `transactions.receipt_token` column or use a derivation).
- **Do NOT** make the sms-dispatch Edge Function idempotent (de-dupe by transaction_id). Re-sends are intentional; the support flow can submit the same transaction_id multiple times to send multiple SMS (e.g., retried receipts after Termii reports a permanent failure). Each call creates a new row.
- **Do NOT** require re-auth on sms-dispatch. Re-sending an SMS to a saver the collector already owns is not a sensitive operation per FR5.
- **Do NOT** log plaintext phone numbers or SMS bodies anywhere in the Edge Function. Hash via SHA-256 if you must reference; otherwise just log the queue_id.
- **Do NOT** add an audit event to the trigger path. The trigger fires on every transaction commit; the `transaction.committed` audit event already covers it. Adding `sms.queued` on every commit doubles the chain volume for no signal.
- **Do NOT** ship a UI consumer for sms-dispatch in this story. Story 6.6 owns the resend button.
- **Do NOT** validate the recipient phone number's E.164 shape in the trigger or the Edge Function. The phone is already trusted (it was Vault-encrypted at member creation per Story 2.2 with Zod validation). Re-validating would duplicate Story 2.2's check.

### Edge cases worth testing (covered by Tasks 5 + 6)

- **Member changes phone between commits.** First commit at phone A → first_receipt SMS. Phone updated via Story 2.5 edit-member. Second commit → subsequent_receipt SMS to phone B. Both rows exist in sms_queue with different recipient_phone values.
- **Cash-only saver, then later phone added.** First commit (no phone) → no sms_queue row. Member edited to add a phone (Story 2.5). Second commit → first_receipt SMS (the trigger correctly identifies "first" because no prior sms_queue row exists for this member's transactions).
- **Re-send via Edge Function for the same transaction.** Two calls to `/sms-dispatch` with the same transaction_id → 2 sms_queue rows. `template_key='subsequent_receipt'` for the second one because the first call's row already exists.
- **Re-send for a member without a phone.** Edge Function returns 200 + skipped indication; no sms_queue row inserted; no audit `sms.queued` event.
- **Re-send for a closed cycle.** No special check — the cycle status doesn't gate SMS resends (the original SMS was sent at commit time when the cycle was active; re-sending the receipt for an old transaction is legitimate). The trigger's gate is independent.
- **Re-send for an undone transaction (Story 4.5).** The Edge Function does NOT block this — the SMS row will be inserted, but Story 6.2's worker will filter it out via the `transactions.undone_at IS NULL` check. Document this hand-off explicitly.

### Definition-of-done checklist

- All 16 ACs satisfied + all 9 tasks ticked.
- 3 migrations applied (extend schema + trigger replace + audit_append_external helper).
- `npm run db:types` regenerated.
- ≥ 5 trigger contract tests + ≥ 8 Edge Function contract tests pass.
- All gates green: typecheck / lint / test --coverage / test:edge / build.
- Story status set to `review`; sprint-status updated.
- Epic 6 status flipped to `in-progress`.
- Hand-offs documented for Stories 6.2 (drain query + filter on undone tx), 6.3 (template rendering at body field write time), 6.4 (receipt URL token), 6.5 (sms_opt_out).
- `attempts` column deprecation noted for a future cleanup migration.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 955-967 (Story 6.1 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` (FR27 — automatic SMS receipt; NFR-R4 — durable commitment, exponential backoff; NFR-P4 — p95 ≤ 60 s).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md:46` (durable SMS commitment table).
  - `_bmad-output/planning-artifacts/architecture.md:99` (Termii via Edge Functions).
  - `_bmad-output/planning-artifacts/architecture.md:643` (exponential backoff 10 s → 10 min, abandon at 24 h).
  - `_bmad-output/planning-artifacts/architecture.md:824-826` (sms-dispatch + sms-worker file slots).
  - `_bmad-output/planning-artifacts/architecture.md:1042` (Edge Function `/functions/v1/sms-dispatch` route).
- **Schema:**
  - `supabase/migrations/20260419000001_init_schema.sql:152-176` (sms_queue table baseline + initial index).
  - `supabase/migrations/20260419000002_rls_policies.sql:82-83, 132-134` (RLS policies).
  - `supabase/migrations/20260425000006_enqueue_sms_on_transaction.sql` (Story 4.3 trigger this story replaces).
  - `supabase/migrations/20260426000003_add_undone_at_to_transactions.sql` (Story 4.5 — sms_queue FK flipped to SET NULL).
- **Existing helpers:**
  - `supabase/functions/_shared/termii-client.ts` (Story 1.3 — NOT invoked here; Story 6.2 will).
  - `supabase/functions/_shared/auth-check.ts` (JWT extraction).
  - `supabase/functions/_shared/rfc7807.ts` (error response helper).
- **Companion stories:**
  - Story 1.2 — `sms_queue` table + RLS.
  - Story 1.3 — Termii client + `re-auth` Edge Function pattern.
  - Story 4.3 — `enqueue_sms_on_transaction` trigger (Story 6.1 replaces its function body).
  - Story 4.5 — `sms_queue.transaction_id` FK flipped CASCADE → SET NULL; `transactions.undone_at` for Story 6.2's drain filter.
  - Story 5.4 — last writer to `kind='advance'`; the trigger replacement keeps the kind-agnostic insert (covers contribution / rattrapage / advance).
- **Downstream stories (handshakes documented in Dev Notes):**
  - Story 6.2 — drain worker + Termii integration + retry/abandon logic.
  - Story 6.3 — template rendering (replaces the STUB body).
  - Story 6.4 — receipt URL Cloudflare Worker + token slot.
  - Story 6.5 — `members.sms_opt_out` + opt-out enforcement (replaces the placeholder check).
  - Story 6.6 — UI for support resend (consumes `/sms-dispatch`).
- **Process discipline:**
  - `npm run db:migrate` (CLAUDE.md). Local DB applied incrementally.
  - Never log plaintext phone numbers or SMS bodies.

## Dev Agent Record

### Agent Model Used

(filled in by dev agent at implementation time)

### Debug Log References

### Completion Notes List

### File List

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-27 | Winston (architect) | Story 6.1 spec generated by `bmad-create-story`. Opens Epic 6 (Saver Trust Communications) with the durable SMS commitment infrastructure: extends `sms_queue` with `template_key` (CHECK-constrained to 4 valid keys), `retry_count`, `next_retry_at`, `abandoned_at` + a partial drain index; replaces the Story 4.3 `enqueue_sms_on_transaction` trigger function to populate the new columns + pick `first_receipt` vs `subsequent_receipt` template_key based on saver's SMS history; ships a SECURITY DEFINER `audit_append_external` helper for the new `sms.queued` event taxonomy; ships the `/functions/v1/sms-dispatch` Edge Function (POST, JWT-auth, RLS-respecting transaction lookup, RFC 7807, structured logging, audit-event emission). Hands off explicitly: Story 6.2 (worker + Termii + retry), Story 6.3 (template rendering), Story 6.4 (receipt URL), Story 6.5 (opt-out flag). NO Termii call, NO template rendering, NO worker drain in this story. Status → ready-for-dev. |
