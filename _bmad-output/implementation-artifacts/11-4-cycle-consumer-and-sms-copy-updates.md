# Story 11.4: Cycle-day denominator display copy (`/30` → `/N`)

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **saver**,
I want **the "jour X/30" denominator on my SMS receipt, my receipt-URL page, and the collector's app to reflect my actual cycle length**,
so that **a member enrolled mid-month (24-day cycle) sees "jour 7/24" — not the misleading "jour 7/30" that would say my cycle is bigger than it is.**

> **Last story of Epic 11. The math is closed.** Stories 11.2 + 11.3 made the engine and the server compute the right numbers for variable-length cycles. This story is **display copy only** — it threads the cycle's actual length into the `/30` denominator surfaces that were intentionally deferred from 11.2/11.3.
>
> **Scope was narrowed** by the 11.3 code-review handoff (`sprint-status.yaml` 11-4 entry comment, 2026-05-20). Originally the proposal listed consumer math + SMS denominator together; 11.2 + 11.3 absorbed all the math; 11.4 is the smallest of the Epic 11 stories.

## Context

After Stories 11.2 + 11.3, the cycle engine and all RPCs operate on variable cycle length (`end_date − start_date + 1`). The UI's view-model `MemberWithMeta.currentCycle` carries `cycleLength`. The receipt-URL `get_receipt_payload` returns `cycle_start_date` + `cycle_end_date`. `format_sms_body`'s `v_projected` already reads the cycle dates. **The data is already on every surface that displays a cycle day** — only the rendered denominator is still hardcoded `30`.

Exhaustive inventory of the `/30` display surfaces (grep-confirmed 2026-05-20):

| Surface | File | Current |
|---|---|---|
| Client share-receipt OS-sheet text | `src/features/transaction/api/shareReceipt.ts:50` | `` `… jour ${cycleDay}/30 …` `` |
| Member-list card label | `src/i18n/fr.json:141` (`members.card.cycle_day`) | `"Jour {day}/30"` |
| Member-profile field | `src/i18n/fr.json:247` (`members.profile.field.cycle_day`) | `"Jour {n} sur 30"` |
| Advance-flow situation row | `src/i18n/fr.json:388` (`advance.flow.situation.day_value`) | `"{day}/30"` |
| Transaction receipt sheet | `src/i18n/fr.json:562` (`transaction.receipt_sheet.cycle_day_value`) | `"Jour {n} sur 30 — Cycle {cycle_number}"` |
| Server SMS — `first_receipt` template | `format_sms_body` PL/pgSQL (latest: migration 20260519215232 lines 720-723) | `'… jour %s/30 …'` |
| Server SMS — `subsequent_receipt` template | same migration lines 725-728 | `'… jour %s/30 …'` |
| Receipt-URL page (Cloudflare Worker) | `workers/receipt-url/src/render.ts:350` | `${payload.cycle_day} / 30` |

All seven surfaces show "30" regardless of the cycle's actual length. After this story, every surface shows the cycle's own `cycleLength`.

## Acceptance Criteria

> Numbered for traceability. **Given/When/Then** lines come from `epics.md` Story 11.4. The rest are spec-derived. The authoritative source for cycleLength is the cycle row's `end_date − start_date + 1`.

1. **`shareReceipt.ts` text — signature gains `cycleLength`.** **Given** the share sheet helper, **When** the refactor lands, **Then** `ShareReceiptInput` gains `cycleLength: number` and the share text becomes `` `… jour ${cycleDay}/${cycleLength} …` ``. The single caller (`src/app/routes/members/[id].tsx:214`) passes `data.currentCycle.cycleLength` (the cycle row already loaded by `useMemberProfile`; `MemberProfile`'s `currentCycle: CycleRow` carries `start_date` + `end_date`, derive once). Existing `shareReceipt.test.ts` cases keep their value-level assertions if fixtures use a 30-day cycle (still "jour N/30"); add ONE case for a partial cycle (`cycleLength: 24`) asserting the share text reads `"jour 7/24"`.

2. **i18n strings — gain `{total}` interpolation.** **Then** the 4 fr.json keys above each gain a `{total}` placeholder replacing the literal `30`:
   - `members.card.cycle_day`: `"Jour {day}/30"` → `"Jour {day}/{total}"`
   - `members.profile.field.cycle_day`: `"Jour {n} sur 30"` → `"Jour {n} sur {total}"`
   - `advance.flow.situation.day_value`: `"{day}/30"` → `"{day}/{total}"`
   - `transaction.receipt_sheet.cycle_day_value`: `"Jour {n} sur 30 — Cycle {cycle_number}"` → `"Jour {n} sur {total} — Cycle {cycle_number}"`

3. **i18n consumers — pass `total`.** **Then** each consumer interpolates `total` from `cycleLength`:
   - `MemberCard.tsx:75` — `t("members.card.cycle_day", { day: cycle.dayNumber, total: cycle.cycleLength })`.
   - `MemberProfile.tsx:123` — `t("members.profile.field.cycle_day", { n: stats.cycleDay, total: <cycleLength from the loaded cycle row> })`. `stats` is from `computeMemberStats` (does not currently expose cycleLength); thread from `data.currentCycle` directly OR add `cycleLength` to the `MemberStats` shape (the engine refactor in 11.2 already computes it internally for `daysRemaining` — exposing it is a tiny additive change). Prefer the latter: cleaner, single source.
   - `AdvanceFlow.tsx:184` — `t("advance.flow.situation.day_value", { day: data.stats.cycleDay, total: <cycleLength> })`. Same source.
   - `TransactionReceiptSheet.tsx:150` — `t("transaction.receipt_sheet.cycle_day_value", { n: transaction.cycle_day, total: <cycleLength>, cycle_number: <unchanged> })`. The sheet receives the transaction from the parent route, which has `data.currentCycle.cycleLength`. Add a `cycleLength` prop to the sheet (similar to the `AdvanceSimulationPanel cycleLength` prop from Story 11.2).

4. **Cloudflare Worker — `render.ts` cycle-day denominator from payload dates.** **Then** `workers/receipt-url/src/render.ts:350` becomes:
   ```ts
   <dd>${payload.cycle_day} / ${cycleLength(payload)}</dd>
   ```
   where `cycleLength(payload)` is a one-line helper: `daysBetween(cycle_start_date, cycle_end_date) + 1`. The payload already carries `cycle_start_date` + `cycle_end_date` (Story 7.5 / `get_receipt_payload`). Add the helper + an explicit test case for a 24-day cycle showing `7 / 24`.

5. **Server SMS — `format_sms_body` template denominator from cycle row.** **Then** a new migration (`npm run db:migrate:new sms_body_dynamic_cycle_length`) drops + recreates `format_sms_body` with the `first_receipt` + `subsequent_receipt` template strings updated to interpolate the cycle's own length:
   ```
   '… jour %s/%s. Solde projete …', v_tx.cycle_day, v_cycle_length, …
   '… recu, jour %s/%s. Solde projete: …', v_tx.cycle_day, v_cycle_length, …
   ```
   `v_cycle_length` is already computed in the function body (Story 11.3 added it to compute `v_projected`); just thread it into `format()` calls. The migration uses `CREATE OR REPLACE` (signature unchanged) — idempotent.

6. **GSM-7 / single-SMS discipline preserved.** **Then** the new template, with the longest realistic interpolated denominator (`/31` — 2 chars), keeps the SMS body within the 160-character GSM-7 single-SMS limit. The pre-11.4 `/30` was 3 chars; `/31` is 3 chars too; `/24` is 3 chars. No length budget change. (Cite the Story 7.5 boundary contract test: `sms-templates-length.contract.test.ts`.)

7. **Update consumer tests.** **Then** every existing test asserting the old hardcoded `30` denominator is updated. The catalog:
   - `src/features/member/ui/MemberCard.test.tsx:58` — `"Jour 25/30"` stays valid (fixture cycleLength=30) once the test passes `total: 30` in the fixture (already part of `currentCycle` post-11.2).
   - `src/features/member/ui/MemberProfile.test.tsx:80` — `/Jour 11 sur 30/` stays valid (30-day fixture).
   - `src/features/cycle/ui/CycleProgressBar.test.tsx:16` — `aria-label="Jour 15 sur 30"` stays valid only if the progress bar's `aria-label` derives `total` from props. Update the component if it currently hardcodes "30" in the aria-label string.
   - `src/features/transaction/ui/TransactionReceiptSheet.test.tsx:66` — `/Jour 3 sur 30 — Cycle 7/i` stays valid (30-day fixture) once `cycleLength` prop is wired.
   - `src/features/transaction/ui/AdvanceFlow.test.tsx:136` — `/^10\/30$/` stays valid (30-day fixture).
   - `src/features/transaction/api/shareReceipt.test.ts` — existing cases stay valid (existing fixtures use `cycleDay: N`; add `cycleLength: 30` to the input); ADD a new case asserting partial-cycle text (`cycleLength: 24` → "jour 7/24").
   - `workers/receipt-url/src/render.test.ts:59,167` — update fixtures + assertions for the dynamic denominator.

8. **E2E — `flow-2-cycle-restart.spec.ts:74` denominator-agnostic.** **Then** the assertion `expect(page.getByText(/Jour 1 sur 30/i)).toBeVisible()` is changed to a regex that admits any denominator: `/Jour 1 sur \d+/i`. After Story 11.3, `restart_member_cycle` produces a calendar-month cycle whose length depends on today's date; pinning the test to "30" via a service-role UPDATE was rejected because that would mask the very change 11.4 is shipping. Leave the assertion denominator-free — the value test is `Jour 1` (the day number).

9. **E2E — `flow-2-member-profile.spec.ts:55` stays valid.** **Then** the seed for this test uses `seedMembersForCollector` which inserts a 30-day cycle directly via service-role (`tests/e2e/fixtures/seed-collector.ts:142`). After 11.4 the denominator will be `30` (= the seed's actual cycleLength). The existing regex `/Jour \d+ sur 30/i` continues to match. **No change needed.** Verify by reading the test; if any other E2E asserts a hardcoded "30" against a `create_member_with_cycle` / `restart_member_cycle` derived cycle, update similarly to AC #8.

10. **`MemberStats` may gain a `cycleLength` field.** **Then** if Task 3 chooses to expose `cycleLength` on the `MemberStats` shape (the cleaner option per AC #3 commentary), update `computeMemberStats` in `src/domain/cycle/cycleEngine.ts` to set `cycleLength` from `cycleLengthDays(startDate, endDate)`. Update the engine test to assert it. **100% coverage on `src/domain/cycle/` must remain green.** This is the only domain-engine change in 11.4.

11. **No SQL math change.** **Then** the migration only changes the `format` call's template string and adds `v_cycle_length` to its argument list — the payout / capacity / cycle-bounds math is unchanged from 11.3. NFR-R3 untouched.

12. **No new dependencies. No new audit events. No view changes.**

13. **All gates green before push.** **Then**: `npm run typecheck` / `npm run lint --max-warnings=0` / `npm run test --coverage` (≥ 75% global branches, 100% on `src/domain/cycle/`) / `npm run build` / `npm run db:migrate` (apply the new SMS-body migration locally) / `psql` smoke-test `format_sms_body('first_receipt', tx_id)` for a 24-day-cycle transaction asserts the output contains "jour 1/24" — **explicitly verify the dynamic denominator end-to-end at the SQL layer before push** (memory `feedback_migration_rpc_smoke_test`).

14. **E2E rigor.** **Then** before pushing, audit:
    - Every E2E asserting `"sur 30"` or `"/30"` is either using a 30-day fixture (passes) OR is updated to a `\d+` regex (passes).
    - The `format_sms_body` SMS-length contract test (`sms-templates-length.contract.test.ts`) still passes against the new interpolated template.

## Tasks / Subtasks

- [ ] **Task 0 — Read the inputs (AC #1 #2 #3).** Re-read the latest `format_sms_body` (migration 20260519215232 lines 700-...), `shareReceipt.ts`, `fr.json` lines 141 / 247 / 388 / 562 + their consumers, and `workers/receipt-url/src/render.ts`. Confirm `cycleLength` is reachable on every surface (it is — verified by inventory grep).

- [ ] **Task 1 — i18n strings (AC #2).** Update the 4 `fr.json` keys to take `{total}` interpolation. **TypeScript types in `src/i18n/keys.ts` (or equivalent typed-i18n file)** must accept `total` in the interpolation params — verify with `npm run typecheck` before moving on.

- [ ] **Task 2 — `shareReceipt.ts` + its caller (AC #1).** Add `cycleLength` to `ShareReceiptInput`; update the template literal. Update `src/app/routes/members/[id].tsx:214` to pass `data.currentCycle.cycleLength`. Update `shareReceipt.test.ts` (+1 new partial-cycle case).

- [ ] **Task 3 — UI consumers (AC #3 #10).** Decide: thread `cycleLength` through props OR expose it on `MemberStats`. Recommend exposing on `MemberStats` (Task 4 covers the engine edit). Update `MemberCard`, `MemberProfile`, `AdvanceFlow`, `TransactionReceiptSheet` to pass `total`. Add `cycleLength` prop to `TransactionReceiptSheet` if needed (mirrors `AdvanceSimulationPanel.cycleLength` from 11.2).

- [ ] **Task 4 — `computeMemberStats` exposes `cycleLength` (AC #10).** Add `cycleLength: number` to the `MemberStats` interface; set it from `cycleLengthDays(startDate, endDate)` when a current cycle exists (0 when null). Update the engine test (1 line); run `npm run test -- --coverage src/domain/cycle/cycleEngine.test.ts` — must stay at 100%.

- [ ] **Task 5 — Cloudflare Worker `render.ts` (AC #4).** Add a `daysBetweenInclusive(start, end)` helper inside `render.ts` (or import from the engine if Deno-compatible — it is; `cycleLengthDays` is pure). Update line 350 to render `${payload.cycle_day} / ${cycleLength(payload)}`. Update `render.test.ts` cases.

- [ ] **Task 6 — New migration for `format_sms_body` (AC #5 #6).** `npm run db:migrate:new sms_body_dynamic_cycle_length`. `CREATE OR REPLACE` `format_sms_body` with the full latest 10.5/11.3 body; change ONLY the two `format(...)` calls for `first_receipt` + `subsequent_receipt` so the denominator interpolates `v_cycle_length`. Then **psql-smoke-test** the function output for a 24-day partial cycle BEFORE moving on (memory `feedback_migration_rpc_smoke_test`).

- [ ] **Task 7 — Tests (AC #7 #8 #9 #14).** Update each consumer test that asserts the old denominator. Replace E2E `flow-2-cycle-restart.spec.ts:74` regex to `\d+`. Grep `tests/e2e/` for any other hardcoded `"sur 30"` / `"/30"` and audit each (most use `seedMembersForCollector` legacy 30-day fixture and stay valid; only restart-driven and create_member_with_cycle-driven cycles produce a variable denominator).

- [ ] **Task 8 — All gates green LOCALLY before push (AC #13 #14).**
  - `npm run typecheck`.
  - `npm run lint`.
  - `npm run test -- --coverage` (cycle domain 100%, global ≥ 75%).
  - `npm run db:migrate` (apply the new migration locally).
  - **`psql` smoke-test**: invoke `format_sms_body('first_receipt', tx_id)` against a seeded 24-day cycle transaction, assert the output contains `"jour 1/24"` (verbatim).
  - `npm run build`.
  - Audit grep for any leftover `"/30"` / `"sur 30"` in `src/`, `workers/`, `tests/e2e/`, `supabase/migrations/` that has NOT been intentionally left (e.g. legacy-30-day fixture tests).
  - **Read every test file my changes touched** + a grep audit for "sur 30" / "/30" before pushing — Story 11.3 taught the cost of skipping this.

- [ ] **Task 9 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `11-4-cycle-consumer-and-sms-copy-updates: ready-for-dev` → `review`.
  - This is the LAST story of Epic 11 — after merge, `epic-11` flips `in-progress` → `done`.

## Dev Notes

### Architecture compliance

- **No layering violation.** Display-copy changes flow through the existing i18n + props paths. No new infrastructure imports.
- **Single source of truth for cycle length** — every surface derives `cycleLength` from the cycle row's `start_date`/`end_date` (engine helper `cycleLengthDays(start, end)`), never from a constant.
- **NFR-R3 untouched** — no math changes (the projected balance, the payout, the capacity are all set by 11.2/11.3).

### Why not pin every variable-length cycle in tests to 30-day?

The 11.3 review-fix pin pattern (`test-fixtures.ts seedMemberWithCycle` UPDATEs to 2026-04-01..2026-04-30 after creation) was the right call for stories where the cycle length must stay 30 to validate `× 29` math against a fixed denominator. **11.4's whole point is the opposite** — to make the denominator variable. The E2E that pins is `tests/e2e/receipt-url-worker.spec.ts seedMemberWithTransaction` (which my 11.3 fix added); its purpose is asserting `14_500 FCFA` projected balance, NOT the cycle-day denominator. That pin stays. For tests asserting the displayed denominator (`flow-2-cycle-restart`), make the regex denominator-agnostic.

### Smoke-test discipline (memory `feedback_migration_rpc_smoke_test`)

Story 11.3 cost three CI iterations because I skipped the psql smoke-test of the RPCs. AC #13 mandates: **before push, invoke `format_sms_body('first_receipt', tx_id)` via psql against a 24-day-cycle transaction and confirm the output contains `"jour 1/24"`.** This is non-optional — Task 6 cannot tick complete without this concrete output.

### Anti-patterns (do NOT do)

- **Do NOT change the displayed `jour` label** itself. Keep "jour" / "Jour" lowercase/uppercase exactly as in the existing strings.
- **Do NOT add a column to `transactions`** to persist `cycle_length`. Always derive from the joined `cycles` row.
- **Do NOT touch the math anywhere.** No edits to `cycleEngine.ts` other than the small additive `cycleLength` field on `MemberStats`.
- **Do NOT widen the `format_sms_body` template** — keep the GSM-7 / 160-char single-SMS discipline (Story 7.5 contract); the longest denominator is `/31`, same width as `/30`.
- **Do NOT pin variable cycles in tests** for assertions about the denominator. Make the assertion denominator-agnostic instead.
- **Do NOT skip the psql smoke-test** (Task 6 / 8). Memory `feedback_migration_rpc_smoke_test` is explicit and was earned the hard way in Story 11.3.
- **Do NOT change `members_decrypted` / `transactions_decrypted` views** — no new columns (memory `project_views_after_columns`).

### Definition-of-done checklist

- All 14 ACs satisfied + all 9 tasks ticked.
- Every `/30` display surface inventoried in Context now reads `/cycleLength`.
- `format_sms_body` migration applied locally; psql smoke confirms `"jour 1/24"` in the output for a 24-day-cycle transaction.
- `typecheck` / `lint` / `test --coverage` (cycle domain 100%) / `build` / `db:migrate` all green LOCALLY.
- `npx playwright test` deferred to CI (Stories 7.4/7.5 precedent); E2E assertions audited per AC #14.
- Story status → `review`; `sprint-status.yaml` updated; **prepare to flip `epic-11` → `done` on merge.**

## References

- **Spec source:** `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-19.md` § "Epic 11 story cluster" — 11.4 row. Scope narrowed by the 11.3 code-review handoff (sprint-status `11-4-cycle-consumer-and-sms-copy-updates` entry, 2026-05-20).
- **Predecessors merged:**
  - Story 11.1 (ADR-004 amendment) — `_bmad-output/implementation-artifacts/11-1-adr-004-variable-length-amendment.md` (PR #116).
  - Story 11.2 (engine refactor) — `_bmad-output/implementation-artifacts/11-2-cycle-engine-variable-length.md` (PR #117).
  - Story 11.3 (SQL RPCs) — `_bmad-output/implementation-artifacts/11-3-month-aligned-cycle-dates-rpc.md` (PR #118). Read its "code review findings" section and the resulting commit `5726d9c` — the PG-17 enum-cast lesson applies any time a CREATE OR REPLACE in this migration is touched.
- **Surfaces to edit:**
  - `src/features/transaction/api/shareReceipt.ts`, `src/app/routes/members/[id].tsx`.
  - `src/i18n/fr.json` (4 keys: lines ~141 / 247 / 388 / 562).
  - `src/features/member/ui/MemberCard.tsx`, `src/features/member/ui/MemberProfile.tsx`, `src/features/transaction/ui/AdvanceFlow.tsx`, `src/features/transaction/ui/TransactionReceiptSheet.tsx`.
  - `src/domain/cycle/cycleEngine.ts` (`MemberStats.cycleLength`).
  - `workers/receipt-url/src/render.ts`.
  - New migration: `supabase/migrations/<ts>_sms_body_dynamic_cycle_length.sql` — `CREATE OR REPLACE format_sms_body` reproduced from the latest 11.3 version (`20260519215232`); only the two `format()` calls for `first_receipt` + `subsequent_receipt` change.
- **Test files to update:**
  - `src/features/member/ui/MemberCard.test.tsx`, `MemberProfile.test.tsx`.
  - `src/features/cycle/ui/CycleProgressBar.test.tsx`.
  - `src/features/transaction/ui/TransactionReceiptSheet.test.tsx`, `AdvanceFlow.test.tsx`.
  - `src/features/transaction/api/shareReceipt.test.ts` (+1 new case).
  - `workers/receipt-url/src/render.test.ts`.
  - `tests/e2e/flow-2-cycle-restart.spec.ts:74` (denominator-agnostic regex).
- **Operating discipline (memory):**
  - `feedback_migration_rpc_smoke_test` — psql-smoke RPC migrations before push.
  - `feedback_rigor_before_deploy` — read every changed file + grep audit before push.
  - `feedback_ci_logs` — read actual log lines and quote exact error text.
  - `feedback_always_feature_branch` — work on `feat/11-4-cycle-consumer-and-sms-copy-updates`.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-05-20 | Winston (architect) | Story 11.4 spec generated by `bmad-create-story`. LAST story of Epic 11. Smallest scope — display copy only: thread the cycle's actual length into the 7 `/30` denominator surfaces (shareReceipt text, 4 i18n strings, format_sms_body first/subsequent receipts, Cloudflare Worker receipt page). `MemberStats` gains an additive `cycleLength` field; no other math change. New migration `CREATE OR REPLACE format_sms_body` with the denominator interpolated. AC #13 mandates a psql smoke-test of the new SMS body before push (the discipline Story 11.3 cost three CI iterations to learn). After merge, `epic-11` flips `in-progress` → `done`. Status → ready-for-dev. |
