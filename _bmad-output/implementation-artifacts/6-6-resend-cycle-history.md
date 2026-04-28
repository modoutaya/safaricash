# Story 6.6: Resend full cycle history to saver (support scenario)

Status: ready-for-dev

## Story

As a **collector (or support agent on behalf of)**,
I want **to re-deliver a saver's full cycle history as SMS**,
so that **a saver who lost SMS or changed phones can recover their proof (FR33).**

> **Predicate of this story.** Story 6.1 / 6.2 / 6.3 / 6.5 fully wired the SMS dispatch loop: trigger → `format_sms_body` → worker → Termii → opt-out gate. Story 6.6 reuses that loop end-to-end — it does NOT call Termii directly. Instead, the collector-side action enqueues a NEW set of `sms_queue` rows (one per historical transaction in the chosen cycle) with `template_key='resend'` and bodies that prepend *"Rappel — transaction du {date}: "* to the existing `subsequent_receipt` body. The worker (Story 6.2) drains these rows like any other. **Per FR5 + PRD v1.3** the action requires **password re-auth** (not OTP — the BDD line 1053 wording predates v1.3); the existing `re-auth` Edge Function already lists `'sms_resend'` in its `OperationIntentSchema`. **What Story 6.6 does NOT ship**: the per-transaction share/resend (Story 6.7's territory — single-tap on a single transaction); a "summary SMS" alternative path (the BDD line 1051 mentions it as an *or* — Story 6.6 ships ONLY the per-transaction path; the summary path is deferred); a SMS-volume budget cap (operator-level Termii quotas handle this externally — out of scope at the app layer); the WhatsApp variant (Story 6.8). The collector-facing UI is in scope (member profile action + re-auth + toast).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 1049-1054; the rest are spec-derived constraints required for a flawless implementation.

1. **Schema — `template_key` CHECK extension.** New migration `20260502000001_extend_sms_queue_template_resend.sql`:
   - Drop the existing `sms_queue_template_key_chk` constraint (it's `NOT VALID`-validated).
   - Re-add it with the new allowed value: `CHECK (template_key IN ('first_receipt', 'subsequent_receipt', 'settlement', 'dispute_ack', 'resend'))`.
   - Re-`VALIDATE` (no rows currently use `'resend'`, so the validation pass is a no-op).
   - **Documents** in the migration comment that Story 6.6 introduces `'resend'`; subsequent stories may extend the set further.

2. **Schema — `audit_append_external` allowlist extension.** New migration `20260502000002_audit_append_external_extend_resend.sql`:
   - Re-derive from Story 6.5 baseline (migration 0046, `20260501000003_audit_append_external_extend_optout.sql`).
   - Replace `IF p_event_type NOT IN ('sms.queued', 'sms.sent', 'sms.failed', 'sms.abandoned', 'sms.opt_out')` with `... 'sms.opt_out', 'sms.resend_initiated')`.
   - Update the function comment.
   - Diff vs migration 0046: 1 allowlist line + 1 comment line. Same byte-for-byte canonical-serialiser discipline as Stories 6.2 / 6.5.

3. **Helper SQL function — `format_resend_sms_body(p_transaction_id uuid) RETURNS text`.** Migration `20260502000003_format_resend_sms_body.sql`:
   - SECURITY DEFINER, `search_path = public, pg_temp`.
   - Reads transaction's `created_at`, formats it as `JJ/MM` in Africa/Dakar timezone (per Story 6.3's helper convention).
   - Calls `format_sms_body('subsequent_receipt', p_transaction_id)` to get the base body.
   - Returns `'Rappel — transaction du <JJ/MM>: ' || base_body`.
   - **Length budget**: prefix is `"Rappel — transaction du JJ/MM: "` ≈ 33 chars; subsequent_receipt's worst case is 132. Total ~165 — slightly over the 1-segment budget, falls into 2-segment. **Acceptable for resends** (lower volume than fresh receipts; saver gets the data legibly).
   - **NFR-A6 compliance**: the prefix uses `—` (em-dash) which is NOT GSM-7-safe. Replace with hyphen-space-hyphen `- ` to stay 7-bit ASCII clean. Final prefix: `"Rappel - transaction du JJ/MM: "` (32 chars).
   - Defensive: if `format_sms_body` raises (unknown tx), propagate the exception.
   - GRANT EXECUTE TO authenticated + service_role.

4. **`enqueue_resend_history(p_member_id uuid, p_cycle_id uuid) RETURNS int` RPC.** Migration `20260502000004_enqueue_resend_history.sql`:
   - SECURITY DEFINER, `search_path = public, pg_temp`.
   - Asserts `auth.uid() IS NOT NULL` (28000 if not — defends against service-role-only callers; this RPC runs under the collector's JWT context).
   - Asserts `members.id = p_member_id AND members.collector_id = auth.uid()` (P0002 if not — RLS-equivalent ownership check).
   - Asserts `cycles.id = p_cycle_id AND cycles.member_id = p_member_id` (P0002 if not — cycle belongs to the member).
   - **Story 6.5 handshake — opt-out short-circuit**: if `members.sms_opt_out IS true`, the RPC returns 0 (no rows enqueued, no audit emitted). **Reasoning**: an opted-out saver should not receive resends; the collector taps the button as a support action but the gate stops it server-side. Caller logs/toasts as "0 sent — saver opted out".
   - Decrypts the saver's phone via `vault_decrypt(members.phone_number_encrypted)`. If empty (cash-only saver), return 0 (no audit, no rows).
   - Selects all transactions in the cycle filtered by `undone_at IS NULL` (Story 4.5 handshake) AND `kind IN ('contribution', 'rattrapage', 'advance')` (mirrors the trigger's filter — settlement transactions don't get resent here; that's Story 7.5's responsibility).
   - For each transaction: `INSERT INTO sms_queue (collector_id, transaction_id, recipient_phone, body, status, template_key, retry_count) VALUES (auth.uid(), tx.id, v_phone, format_resend_sms_body(tx.id), 'queued', 'resend', 0)`.
   - Emits ONE `sms.resend_initiated` audit event with payload `{member_id, cycle_id, count: <int>}` via `audit_append_external` (4-arg variant — `auth.uid()` is set by the RPC's invocation context).
   - Returns the count of inserted rows.
   - GRANT EXECUTE TO authenticated.

5. **Edge Function `/functions/v1/sms-resend-history`** at `supabase/functions/sms-resend-history/index.ts`:
   - **Method:** POST only (else 405).
   - **Auth:** Bearer JWT in `Authorization` header. Use `assertAuthenticated`.
   - **Body:** `{ member_id: uuid, cycle_id: uuid, password: string }`. Zod-light validation (no jsr:zod cold-start tax — manual checks like Story 6.2's pattern).
   - **Logic:**
     1. JWT auth → `collectorId`.
     2. Verify password via the same `signInWithPassword` pattern the `re-auth` Edge Function uses. **Code reuse**: extract the password-verify path from `re-auth/index.ts` into a SHARED helper at `_shared/verify-password.ts` (~30 lines), then both functions import it. The helper takes `(req, anonClient, serviceClient, collectorId, password)` → returns `{ ok: true } | { ok: false, problem }`. The shared helper handles: phone resolution, fresh anon client per request (no session bleed), structured logging, RFC 7807 error mapping.
     3. If password invalid → 401 RFC 7807 `credentials_invalid`.
     4. Build a JWT-bound supabase-js client (the user's JWT), call `enqueue_resend_history(p_member_id, p_cycle_id)`. RLS / RPC's own ownership checks gate access.
     5. If RPC raises:
        - `28000` → 401 `auth_unauthenticated` (shouldn't happen — defensive).
        - `P0002` → 404 `not_found`.
        - any other → 500 `internal_unexpected`.
     6. Return 200 `{ enqueued: <int> }`.
   - **Logging:** structured JSON; collector_id + member_id + count; never log password / phone.
   - **No re-auth required for this Edge Function ITSELF** — the password-verify step IS the re-auth (mirrors how re-auth/index.ts works).

6. **Shared verify-password helper.** New `supabase/functions/_shared/verify-password.ts`:
   - Extracted from `re-auth/index.ts` lines that resolve `phone` + create a fresh anon client + call `signInWithPassword`.
   - Updates `re-auth/index.ts` to import from the new shared module — **no behaviour change**; just a code-sharing refactor.
   - **Why now and not earlier**: Story 1.5b shipped re-auth as a single endpoint; Story 6.6 is the first additional consumer. Mirrors the Story 6.2 pattern of extracting `seedCollector` to `_shared/test-fixtures.ts` once a second consumer landed.

7. **Story 6.5 handshake — opt-out gate.** The RPC short-circuits when `members.sms_opt_out=true` (AC #4). The Edge Function does NOT need its own opt-out check — single source of truth at the RPC. The Edge Function's response is still 200 `{ enqueued: 0 }` in that case; the UI toast distinguishes "0 sent — saver opted out" vs "0 sent — no transactions".
   - **UI distinction**: the Edge Function returns `{ enqueued: <int>, reason?: 'opt_out' | 'no_transactions' | null }` so the collector-side toast can render the right message.
   - **RPC return shape change**: the RPC returns a `record` `(enqueued int, reason text)` instead of plain int. Edge Function adapts.

8. **Cycle gate**. The RPC accepts ANY cycle for the member (active or settled). **Reasoning**: a saver might ask for the history of cycle 1 even though cycle 2 is in progress. Past-cycle resends are a normal support flow.

9. **Re-send rate self-protection.** The RPC does NOT enforce a server-side rate limit (e.g., "don't allow two resends within 5 minutes"). **Reasoning**: at MVP, this is a low-volume support flow; the collector is in the loop and won't accidentally double-tap. The audit log captures every `sms.resend_initiated`, so abuse is observable post-hoc. **Future**: Story 6.X could add a 5-minute debounce in the RPC if abuse pattern emerges.

10. **i18n keys** (fr-only at MVP; add to `src/i18n/fr.json`):
    - `member.profile.actions.resend_history`: *"Renvoyer l'historique"*
    - `member.profile.resend_history_dialog.title`: *"Renvoyer l'historique du cycle ?"*
    - `member.profile.resend_history_dialog.body`: *"Le saver recevra un SMS de rappel pour chaque transaction du cycle en cours. L'opération nécessite votre mot de passe."*
    - `member.profile.resend_history_dialog.confirm`: *"Confirmer"*
    - `member.profile.resend_history_dialog.cancel`: *"Annuler"*
    - `member.profile.resend_history_toast.success`: *"{{count}} rappels envoyés."* (use plural rule — *"1 rappel envoyé"* for count=1)
    - `member.profile.resend_history_toast.opt_out`: *"Le saver a refusé les SMS — aucun rappel envoyé."*
    - `member.profile.resend_history_toast.no_transactions`: *"Aucune transaction à renvoyer pour ce cycle."*
    - `member.profile.resend_history_toast.error`: *"Échec de l'envoi des rappels."*

11. **UI — member profile action**. Add to `src/features/member/ui/MemberProfilePage.tsx` (or wherever the existing actions live; verify exact name):
    - A new button *"Renvoyer l'historique"* in the member's actions list. **Visibility**: visible only when `cycle.status === 'active'` AND `member.status === 'active'`.
    - Tap → opens password re-auth dialog (the existing `PasswordReauthDialog` from Story 1.5b — reuse, do NOT clone).
    - On password-verify success → calls `useResendHistory({ memberId, cycleId, password })`.
    - Hook calls the Edge Function `/sms-resend-history` with `{ member_id, cycle_id, password }`.
    - Toast on success / opt-out / no-transactions / error per AC #10.
    - Never logs password client-side.

12. **TanStack Query mutation hook**. New `src/features/member/api/useResendHistory.ts`:
    - `useMutation` calling the Edge Function.
    - On success, **invalidates** `useTransactionList(memberId, cycleId)` query so the UI re-fetches the transaction list (no behaviour change in the list, but the `sms_queue` table changed — relevant for Story 6.7's per-transaction status indicator).
    - Typed errors mirror Story 5.4's `RecordAdvanceInputSchema` shape.

13. **Render unit test for `format_resend_sms_body`** (Deno). New `supabase/functions/_shared/format-resend-sms-body.contract.test.ts`:
    - **Case 1** — happy path: tx with amount=500, day=1, member=Fatou → body starts with *"Rappel - transaction du <JJ/MM>: SafariCash. 500 FCFA recu, jour 1/30. Solde projete: 14 500 FCFA. Detail: ..."*.
    - **Case 2** — date format is `JJ/MM` in Africa/Dakar timezone.
    - **Case 3** — body is pure 7-bit ASCII (NFR-A6 regex `^[\x20-\x7E]+$`).
    - **Case 4** — invalid transaction_id → propagates `format_sms_body`'s `P0002`.

14. **`enqueue_resend_history` RPC contract tests** (Deno). New `supabase/functions/_shared/enqueue-resend-history.contract.test.ts`:
    - **Case 1** — Happy path: cycle with 3 contributions → 3 rows enqueued, all `template_key='resend'`, all bodies start with *"Rappel"*; ONE `sms.resend_initiated` audit event.
    - **Case 2** — Soft-undone transactions filtered: cycle with 3 contributions where 1 was undone → only 2 rows enqueued.
    - **Case 3** — Opt-out short-circuit: member.sms_opt_out=true → returns `{ enqueued: 0, reason: 'opt_out' }`; no rows; no audit event.
    - **Case 4** — Cash-only saver (no phone): empty phone_number_encrypted → returns `{ enqueued: 0, reason: ... }`; no rows; no audit.
    - **Case 5** — Foreign collector: caller's JWT doesn't own the member → P0002.
    - **Case 6** — Member without active cycle: cycle_id doesn't belong to member → P0002.
    - **Case 7** — Empty cycle (no transactions): returns `{ enqueued: 0, reason: 'no_transactions' }`; no audit.

15. **Edge Function contract tests** (Deno). New `supabase/functions/sms-resend-history/index.test.ts`:
    - **Case 1** — Method GET → 405.
    - **Case 2** — Anonymous (no JWT) → 401.
    - **Case 3** — Wrong password → 401 `credentials_invalid`.
    - **Case 4** — Body missing `cycle_id` → 400.
    - **Case 5** — Body invalid uuid for `member_id` → 400.
    - **Case 6** — Foreign member (not owned) → 404 `not_found`.
    - **Case 7** — Happy path: 200 `{ enqueued: <count> }`; service-role-side check that sms_queue rows exist with template_key='resend'; one `sms.resend_initiated` audit event.
    - **Case 8** — Opt-out saver: 200 `{ enqueued: 0, reason: 'opt_out' }`; no rows.

16. **Audit-allowlist regression** (Deno). Extend `_shared/sms-worker-audit-allowlist.contract.test.ts` for-loop with `'sms.resend_initiated'`. The existing `'sms.delivered'`-rejected case still passes.

17. **Render unit tests** (vitest) for the `useResendHistory` hook + the new MemberProfile button + dialog wiring. Pattern mirrors Story 5.4 / 5.3 hook tests.

18. **Playwright E2E**. New `tests/e2e/flow-6-resend-history.spec.ts`:
    - Seed a collector + member + cycle + 2 contributions.
    - Login → navigate to member profile → tap *"Renvoyer l'historique"* → password dialog → submit correct password → toast "2 rappels envoyés".
    - Verify via service-role: 2 sms_queue rows with template_key='resend' for this member.

19. **CI workflow update.** No env / config changes — the resend Edge Function uses the same `assertAuthenticated` + `signInWithPassword` plumbing as `re-auth`.

20. **`run-edge-tests.sh` wires** the 3 new Deno test paths:
    - `supabase/functions/_shared/format-resend-sms-body.contract.test.ts`
    - `supabase/functions/_shared/enqueue-resend-history.contract.test.ts`
    - `supabase/functions/sms-resend-history/index.test.ts`

21. **All gates green.**
    - `npm run db:migrate` — applies 4 new migrations.
    - `npm run db:types --local` — regenerates types so the new RPC signature lands.
    - `npm run typecheck` / `lint` / `test` (vitest with new hook + UI cases) / `test:edge` / `build` — all green.
    - `npx playwright test tests/e2e/flow-6-resend-history.spec.ts` — happy path passes.

## Tasks / Subtasks

- [ ] **Task 1 — Migration 0050: extend `template_key` CHECK to include `'resend'`** (AC: #1)
- [ ] **Task 2 — Migration 0051: extend audit allowlist for `'sms.resend_initiated'`** (AC: #2)
- [ ] **Task 3 — Migration 0052: `format_resend_sms_body` helper** (AC: #3)
- [ ] **Task 4 — Migration 0053: `enqueue_resend_history` RPC** (AC: #4, #7, #8)
  - Returns `(enqueued int, reason text)` record.
  - Story 4.5 / 6.5 handshakes (undone filter + opt-out short-circuit).
  - Emits 1 `sms.resend_initiated` audit per call (when count > 0).
- [ ] **Task 5 — Extract `_shared/verify-password.ts`** (AC: #6)
  - Refactor `re-auth/index.ts` to import the helper. NO behaviour change.
- [ ] **Task 6 — Edge Function `sms-resend-history`** (AC: #5, #7)
  - POST-only; JWT auth; password verify via shared helper; calls RPC under user-scoped client.
- [ ] **Task 7 — `format_resend_sms_body` contract tests** (AC: #13)
- [ ] **Task 8 — `enqueue_resend_history` RPC contract tests** (AC: #14)
- [ ] **Task 9 — Edge Function contract tests** (AC: #15)
- [ ] **Task 10 — Audit-allowlist regression** (AC: #16) — extend the existing for-loop.
- [ ] **Task 11 — i18n keys + UI hook + member profile button + dialog wiring** (AC: #10, #11, #12, #17)
- [ ] **Task 12 — Playwright E2E spec** (AC: #18)
- [ ] **Task 13 — Wire test paths in `run-edge-tests.sh`** (AC: #20)
- [ ] **Task 14 — Verify all gates green** (AC: #21)

## Dev Notes

### Architecture intelligence

- **prd.md:519 (FR33)** — *"A collector can resend a saver's full cycle history, on request, as individual SMS receipts or a summary SMS (support scenario)."*
- **prd.md:479 (FR5)** — re-auth-required operations are settlement / member-delete / csv-export. Story 6.6 ADDS sms_resend to the list (already pre-declared in `re-auth/index.ts:OperationIntentSchema`). Document this in the migration comment.
- **architecture.md:351** — re-auth pattern: dedicated Edge Function accepts password, validates via `supabase.auth.signInWithPassword`. Story 6.6 reuses this via a shared helper (AC #6).
- **Story 6.2 / 6.5 audit-chain discipline** — migrations 0046 / 0051 are 1-allowlist-line + 1-comment-line diffs vs the prior baseline. Same byte-for-byte rule.

### Story 6.5 handshake — opt-out gate

- The RPC short-circuits BEFORE inserting any sms_queue rows when `members.sms_opt_out=true`. **Reasoning**: even with an explicit collector intent, an opted-out saver MUST NOT receive SMS (FR32 — *"the opt-out is recorded in the audit trail"* implies opt-out is binding regardless of channel).
- The UI surfaces this as *"Le saver a refusé les SMS — aucun rappel envoyé."* (i18n key `member.profile.resend_history_toast.opt_out`).

### Story 4.5 handshake — soft-undo invisibility

- The RPC's transaction-list query filters `undone_at IS NULL`. A soft-undone transaction is invisible to the resend path — no rappel is sent for transactions the collector has retracted.
- The `transactions_decrypted` view ALSO filters undone rows; either query path works. The RPC uses the raw `transactions` table with explicit `undone_at IS NULL` (mirroring Story 6.4's `get_receipt_payload` pattern; the view doesn't expose `kind` and `cycle_day` directly... wait, it does. Either pattern is fine. Pick whichever the dev prefers).

### Story 6.7 handshake — per-transaction share

- Story 6.7 will ship a single-transaction resend (vs Story 6.6's full-cycle resend). The two paths share the trigger pipeline (worker, Termii, opt-out gate) but use different RPCs. Story 6.7 may extend `format_resend_sms_body` to accept a `p_template_key` arg so single-transaction resends can use a slightly different prefix (*"Reçu original du JJ/MM: ..."*); Story 6.6 sticks with the *"Rappel"* prefix.

### Length budget caveat (NFR-A6)

- The *"Rappel - transaction du JJ/MM: "* prefix is 32 chars. The base subsequent_receipt body is up to 132 chars. Total worst-case: 164 chars — slightly over the 1-segment SMS limit (160 chars). The resend SMS lands as 2 segments. **Acceptable** for the support flow; documented in the migration comment.
- **NOT GSM-7**: em-dash `—` is NOT in the GSM-7 default alphabet. The prefix uses ASCII hyphen + space + hyphen instead: `"Rappel - transaction du JJ/MM: "`.

### Code-reuse: extract verify-password to shared helper

- The Edge Function does the same password-verify dance as `re-auth/index.ts`. Story 6.6 extracts the helper to `_shared/verify-password.ts` so both functions consume the same implementation. **Behaviour parity** is verified by running the existing `re-auth/index.test.ts` after the refactor — those tests must remain green with zero changes.
- Future stories that need re-auth (Story 7.4 settlement, Story 9.3 CSV export) will also import this helper.

### Project structure notes

- Source tree:
  - NEW: `supabase/migrations/20260502000001_extend_sms_queue_template_resend.sql`
  - NEW: `supabase/migrations/20260502000002_audit_append_external_extend_resend.sql`
  - NEW: `supabase/migrations/20260502000003_format_resend_sms_body.sql`
  - NEW: `supabase/migrations/20260502000004_enqueue_resend_history.sql`
  - NEW: `supabase/functions/_shared/verify-password.ts`
  - NEW: `supabase/functions/_shared/format-resend-sms-body.contract.test.ts`
  - NEW: `supabase/functions/_shared/enqueue-resend-history.contract.test.ts`
  - NEW: `supabase/functions/sms-resend-history/index.ts`
  - NEW: `supabase/functions/sms-resend-history/index.test.ts`
  - NEW: `src/features/member/api/useResendHistory.ts`
  - NEW: `src/features/member/api/useResendHistory.test.ts`
  - NEW: `tests/e2e/flow-6-resend-history.spec.ts`
  - MODIFIED: `supabase/functions/re-auth/index.ts` (import shared helper; no behaviour change)
  - MODIFIED: `supabase/functions/_shared/sms-worker-audit-allowlist.contract.test.ts` (add `'sms.resend_initiated'` to the for-loop)
  - MODIFIED: `src/features/member/ui/MemberProfilePage.tsx` (new action button + dialog wiring)
  - MODIFIED: `src/i18n/fr.json` (8 new keys)
  - MODIFIED: `scripts/run-edge-tests.sh` (3 new test paths)
  - MODIFIED: `src/infrastructure/supabase/database.types.ts` (re-generated; new RPC signature)
  - MODIFIED: `_bmad-output/implementation-artifacts/sprint-status.yaml`
- All paths align with architecture.md § Source Tree.
- No conflicts with prior stories.

### Testing standards

- Edge Function tests: Deno + `jsr:@std/assert@1`, reusing `_shared/test-fixtures.ts`.
- RPC contract tests: cover happy + 4 negative branches + idempotency.
- vitest tests: hook + button + dialog wiring; mirror Story 5.4's `useRecordAdvance` test pattern.
- Playwright: 1 happy-path E2E spec.
- Coverage target: 100% on the SQL helper (4 branches); ≥80% elsewhere.

### References

- [Source: epics.md#Story 6.6] — BDD acceptance criteria.
- [Source: prd.md#FR33] — full-cycle resend support flow.
- [Source: prd.md#FR5] — sensitive-op re-auth.
- [Source: prd.md#NFR-A6] — 7-bit ASCII / GSM-7 SMS body constraint.
- [Source: supabase/functions/re-auth/index.ts] — password-verify pattern Story 6.6 reuses.
- [Source: supabase/migrations/20260501000003_audit_append_external_extend_optout.sql] — Story 6.5 baseline (the migration this story re-derives from).
- [Source: supabase/migrations/20260429000002_format_sms_body.sql] — Story 6.3's helper that `format_resend_sms_body` wraps.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

### Completion Notes List

Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
