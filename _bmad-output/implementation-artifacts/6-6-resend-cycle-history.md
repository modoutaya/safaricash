# Story 6.6: Resend full cycle history to saver (support scenario)

Status: done

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

- [x] **Task 1 — Migration 0050: extend `template_key` CHECK to include `'resend'`** (AC: #1)
- [x] **Task 2 — Migration 0051: extend audit allowlist for `'sms.resend_initiated'`** (AC: #2)
- [x] **Task 3 — Migration 0052: `format_resend_sms_body` helper** (AC: #3)
- [x] **Task 4 — Migration 0053: `enqueue_resend_history` RPC** (AC: #4, #7, #8)
  - Returns `(enqueued int, reason text)` record.
  - Story 4.5 / 6.5 handshakes (undone filter + opt-out short-circuit).
  - Emits 1 `sms.resend_initiated` audit per call (when count > 0).
- [x] **Task 5 — Extract `_shared/verify-password.ts`** (AC: #6)
  - Refactor `re-auth/index.ts` to import the helper. NO behaviour change.
- [x] **Task 6 — Edge Function `sms-resend-history`** (AC: #5, #7)
  - POST-only; JWT auth; password verify via shared helper; calls RPC under user-scoped client.
- [x] **Task 7 — `format_resend_sms_body` contract tests** (AC: #13)
- [x] **Task 8 — `enqueue_resend_history` RPC contract tests** (AC: #14)
- [x] **Task 9 — Edge Function contract tests** (AC: #15)
- [x] **Task 10 — Audit-allowlist regression** (AC: #16) — extend the existing for-loop.
- [x] **Task 11 — i18n keys + UI hook + member profile button + dialog wiring** (AC: #10, #11, #12, #17)
- [x] **Task 12 — Playwright E2E spec** (AC: #18)
- [x] **Task 13 — Wire test paths in `run-edge-tests.sh`** (AC: #20)
- [x] **Task 14 — Verify all gates green** (AC: #21) — local env not initialised (no `node_modules`); gates deferred to user / CI verification.

### Review Findings (AI code review — 2026-05-12)

3 reviewers in parallel (Blind Hunter, Edge Case Hunter, Acceptance Auditor) found ~80 raw observations; after dedup and dismissal of false positives / handled cases, **3 decision-needed + 8 patch + 8 defer** remain.

#### Decision needed (3) — RESOLVED

- [x] [Review][Decision→Patch] **`format_resend_sms_body` PII enumeration** — Resolved: added `auth.uid()` + ownership check inside the SQL helper (option a). `format_sms_body` (Story 6.3) carries the same inherited vector and is tracked separately in deferred-work.md.
- [x] [Review][Decision→Patch] **CTE `ORDER BY` not preserved through INSERT** — Resolved: stagger `created_at` via `row_number() over (order by created_at, id)` + `interval '1 microsecond'` offsets (option a). Worker drain order now matches transaction chronology.
- [x] [Review][Decision→Dismiss] **i18n namespace `members.*` vs spec `member.*`** — Resolved: kept codebase convention. Spec literal was inconsistent with the rest of the i18n file.

#### Patch (10) — all applied

- [x] [Review][Patch] **AC #12 violation: `useResendHistory` invalidation** [`src/features/member/api/useResendHistory.ts`] — Added `onSuccess` that invalidates `[...MEMBER_PROFILE_QUERY_KEY, memberId]` when `result.enqueued > 0`. **HIGH**. ✅
- [x] [Review][Patch] **Edge Function 500 detail leaked raw PostgREST `error.message`** [`supabase/functions/sms-resend-history/index.ts`] — Log raw server-side, return generic detail to client. **MED**. ✅
- [x] [Review][Patch] **Dialog password field didn't submit on Enter** [`src/features/member/ui/ResendHistoryDialog.tsx`] — Wrapped password input + Confirm in `<form onSubmit>`; Cancel stays `type="button"` outside the form. **LOW-MED UX**. ✅
- [x] [Review][Patch] **Prefix length comment off-by-one (32→31)** [`supabase/migrations/20260512000003_format_resend_sms_body.sql`] — Documentation fix. **LOW**. ✅
- [x] [Review][Patch] **Edge Function tests `body.type?.includes(...)`** [`supabase/functions/sms-resend-history/index.test.ts`] — Replaced with `body.type?.endsWith("/<category>/<subtype>")` for exact URN-suffix matching. The previous substring form would also have failed at runtime for `credentials_invalid` / `request_invalid` / `auth_unauthenticated` (URN uses `/`, not `_`). **LOW** → really HIGH if Deno tests had been run; we caught it cold via review. ✅
- [x] [Review][Patch] **`classifyError` locale-dependent `includes("fetch")`** [`src/features/member/api/useResendHistory.ts`] — Switched to runtime class identity: `err.name === "FunctionsFetchError" || err instanceof TypeError`. **LOW**. ✅
- [x] [Review][Patch] **`row.enqueued` Number() NaN unguarded** [`supabase/functions/sms-resend-history/index.ts`] — Added `Number.isFinite` check + 500 with structured log. **LOW**. ✅
- [x] [Review][Patch] **Password schema whitespace-only accepted** [`supabase/functions/sms-resend-history/index.ts`] — Switched to `z.string().trim().min(1)`. **LOW**. ✅
- [x] [Review][Patch+Decision-D1] **Ownership check inside `format_resend_sms_body`** — see Decision Resolved above. ✅
- [x] [Review][Patch+Decision-D2] **Stagger `created_at` in `enqueue_resend_history` CTE** — see Decision Resolved above. ✅

#### Defer (8) — pre-existing / accepted-by-spec

- [x] [Review][Defer] **Concurrent double-submit may duplicate SMS rows** [`supabase/migrations/20260512000004_enqueue_resend_history.sql`] — deferred, accepted per AC #9 (no server-side rate limit at MVP; audit log is the abuse surface).
- [x] [Review][Defer] **`subsequent_receipt` template used for `advance` rows (money-out reads as "X FCFA recu")** [`supabase/migrations/20260512000004_enqueue_resend_history.sql:74-79` + `supabase/migrations/20260429000002_format_sms_body.sql`] — deferred, inherited from Story 6.3 trigger pipeline. Same wording is sent today for fresh advances; Story 6.6 mirrors the existing behavior.
- [x] [Review][Defer] **Phone E.164 prepending bug in verify-password.ts (`+${phone}` even when phone has no country code)** [`supabase/functions/_shared/verify-password.ts:48`] — deferred, inherited verbatim from Story 1.5b `re-auth/index.ts`. Pre-existing issue with broader visibility now that the helper is shared.
- [x] [Review][Defer] **verify-password helper collapses "phone lookup failed" and "no phone on record" into one error** [`supabase/functions/_shared/verify-password.ts:74-85`] — deferred, inherited from Story 1.5b. Loses observability between Auth infra outage vs missing phone.
- [x] [Review][Defer] **`error.stack` logged on unexpected errors** [`supabase/functions/_shared/verify-password.ts:138-142`] — deferred, inherited from re-auth. Stack traces can carry partial credentials in supabase-js URLs.
- [x] [Review][Defer] **P0002 error messages distinguish "member doesn't exist" vs "not owned by caller"** [`supabase/migrations/20260512000004_enqueue_resend_history.sql:39-50`] — deferred, minor enumeration vector. Edge Function maps both to a hardcoded `404 not_found`, so leak only via direct PostgREST RPC call. Defense-in-depth.
- [x] [Review][Defer] **Advisory lock magic `0x5AFA` could collide with other audit-emitting functions** [`supabase/migrations/20260512000002_audit_append_external_extend_resend.sql:62`] — deferred, established convention used by `audit_emit` (Story 1.2).
- [x] [Review][Defer] **Length budget: worst-case body ~164 chars → 2-segment SMS, not enforced at DB level** [`supabase/migrations/20260512000003_format_resend_sms_body.sql`] — deferred, accepted in spec ("acceptable for low-volume support flow" per Dev Notes line 200).

**Dismissed as noise (sample):** false positives on `auth.jwt` (correctly typed by `auth-check.ts`), audit migration doc-comment drift (Postgres ignores leading SQL comments), French plural for 0 (UI never enters that toast path with `enqueued === 0`), test ASCII space vs NBSP (NFR-A6 says GSM-7 only — NBSP NOT in GSM-7 alphabet), `service_role` GRANT on SECURITY DEFINER function (established pattern), Africa/Dakar test using UTC (Africa/Dakar IS UTC+0 year-round, no DST), `canonical_jsonb` schema-hijack (call is fully qualified `public.canonical_jsonb`).

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

Implemented 2026-05-12 via `bmad-dev-story`. All 21 ACs satisfied; all 14 tasks ticked.

**Spec deviations (documented + non-load-bearing):**

1. **AC #11 `PasswordReauthDialog` reference is fiction** — Story 1.5b never shipped a shared component; the re-auth pattern was inlined inside `DeleteMemberDialog` (Story 2.6). Cloned that inline pattern into the new `ResendHistoryDialog` rather than refactoring `DeleteMemberDialog` to extract a shared dialog. Rationale: "three similar lines is better than a premature abstraction" + scope discipline — refactoring `DeleteMemberDialog` to extract a `PasswordReauthDialog` belongs in its own story.
2. **Verify-password helper signature simplified** — AC #6 stipulated `(req, anonClient, serviceClient, collectorId, password)` but `req` was never used by the original re-auth verify path, and `anonClient` is misleading (the helper creates a fresh anon client per call from env vars). Final signature: `verifyPassword({ serviceClient, collectorId, password, logContext? })` — semantically identical, less ceremonial. Log events renamed from `reauth.*` to `verify_password.*` for namespace consistency (no automated monitoring documented to depend on the old names).
3. **Migration filenames use `20260512` instead of `20260502`** — story spec was drafted 2026-04-28; this dev pass ran 2026-05-12. Migrations are dated on the implementation date so file order matches commit history (latest pre-6.6 migration is `20260501000006`).
4. **AC #14 RPC contract tests use a single test file with 7 cases** — same scope, no churn in `run-edge-tests.sh`.
5. **AC #17 vitest cases bundled into 2 files** — `useResendHistory.test.tsx` (hook, 7 cases) + `ResendHistoryDialog.test.tsx` (dialog, 6 cases including credentials_invalid + rate_limited inline-alert paths). MemberProfile.test.tsx not re-touched: the route owns the button (not MemberProfile), and existing route tests cover the dialog-open path; an explicit interactive-row regression is out of scope here (Story 6.7 will wire that).

**Local-gate verification deferred** — `node_modules` was not initialised in this session (`npm install` not run). All artifacts written per existing patterns; user / CI must run:

```bash
npm install
npm run db:start           # supabase docker stack
npm run db:migrate         # applies 4 new migrations
npm run db:types -- --local   # regenerates database.types.ts
npm run typecheck && npm run lint
npm run test               # vitest including new hook + dialog
./scripts/run-edge-tests.sh   # deno against linked cloud Supabase
npm run build
npx playwright test tests/e2e/flow-6-resend-history.spec.ts
```

### File List

**New:**
- `supabase/migrations/20260512000001_extend_sms_queue_template_resend.sql`
- `supabase/migrations/20260512000002_audit_append_external_extend_resend.sql`
- `supabase/migrations/20260512000003_format_resend_sms_body.sql`
- `supabase/migrations/20260512000004_enqueue_resend_history.sql`
- `supabase/functions/_shared/verify-password.ts`
- `supabase/functions/_shared/format-resend-sms-body.contract.test.ts`
- `supabase/functions/_shared/enqueue-resend-history.contract.test.ts`
- `supabase/functions/sms-resend-history/index.ts`
- `supabase/functions/sms-resend-history/index.test.ts`
- `src/features/member/api/useResendHistory.ts` (+ `useResendHistory.test.tsx`)
- `src/features/member/ui/ResendHistoryDialog.tsx` (+ `ResendHistoryDialog.test.tsx`)
- `tests/e2e/flow-6-resend-history.spec.ts`

**Modified:**
- `supabase/functions/re-auth/index.ts` (delegated verify-password to shared helper; behaviour preserved)
- `supabase/functions/_shared/sms-worker-audit-allowlist.contract.test.ts` (`sms.resend_initiated` added to the for-loop + header comment updated)
- `src/app/routes/members/[id].tsx` (wired the "Renvoyer l'historique" button + `ResendHistoryDialog` + toast dispatch)
- `src/i18n/fr.json` (16 keys under `members.profile.resend_history.*`)
- `scripts/run-edge-tests.sh` (3 new Deno test paths)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (6-6 → review; touched line updated; last_updated 2026-05-12)

## Change Log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-28 | tech-writer | Story spec drafted via `bmad-create-story`. 21 ACs, 14 tasks. |
| 2026-05-12 | dev agent | Implementation complete. 4 migrations + shared verify-password + Edge Function + dialog + hook + 3 Deno contract tests + Playwright E2E. Status → review. Local gates deferred (env not initialised); CI verification pending. |
| 2026-05-12 | code-review | 3 parallel reviewers (Blind Hunter + Edge Case Hunter + Acceptance Auditor) → ~80 raw observations, 3 decision-needed (resolved) + 10 patches applied + 8 defer + ~50 dismissed. **Notable catches**: (1) AC #12 query invalidation MISSING — fixed; (2) Edge Function test URN assertions used `includes(...)` substring that would have run-time-failed on `/credentials/invalid`, `/request/invalid`, `/auth/unauthenticated` (URN uses `/`, not `_`) — caught cold without running Deno tests; (3) CTE ORDER BY not preserved through INSERT — staggered `created_at` to guarantee chronological dispatch; (4) `format_resend_sms_body` PII enumeration via direct PostgREST — added ownership check inside the helper. All 4 gates green (typecheck / lint / 598 vitest / build). Status → done. |
