# Story 9.3: CSV export of cycle summaries and transaction history

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **collector**,
I want **to export my cycle commission summaries and transaction history as CSV, behind a password re-auth**,
so that **my accountant can use the data without manual transcription (FR37).**

> **Predicate of this story. THIRD and FINAL story of Epic 9 (Dashboard & Activity Visibility).** Story 9.1 built the dashboard; 9.2 was already-delivered by Story 3.5. Story 9.3 adds the data-export surface — a password-gated "Exporter en CSV" action on `/settings` that produces two downloadable CSV files and records an audit event.
>
> 1. **Two CSVs.** (a) **Cycle summaries** — columns `cycle_id, member_name, cycle_start_date, cycle_end_date, total_contributions, advances_sum, commission, final_payout, status`. (b) **Transaction history** — columns `transaction_id, date, kind, amount, member_id, member_name`. Both trigger a browser download.
> 2. **FR5 password re-auth gate.** Tapping "Exporter en CSV" opens a password dialog; on submit the existing `re-auth` Edge Function verifies the password (`operation_intent: "csv_export"` — already in its enum). Only on a 200 does the export proceed. This mirrors `DeleteMemberDialog` (Story 2.6) exactly.
> 3. **`export.csv_generated` audit event.** After the CSVs are generated the client records an `export.csv_generated` event via the `audit_append_external` RPC — whose allowlist (currently `sms.queued` only) must be extended.
>
> **Re-auth is PASSWORD, not OTP.** The epics text says "OTP verified" — that is stale prose. PRD v1.3 (amendments) switched collector auth to phone+password; FR5 re-auth is password. The `re-auth` Edge Function is built and password-based — DO NOT build an OTP flow.
>
> **Data sources (DO NOT re-invent):**
> - **Cycles** — `public.cycles` (`id, member_id, start_date, end_date, status, settled_payout, settled_at`), RLS-scoped to the collector.
> - **Member names** — `members_decrypted` (`id, name, daily_amount`) — names are vault-encrypted; the decrypted view is the read surface.
> - **Transactions** — `transactions_decrypted` (`id, member_id, cycle_id, kind, amount, created_at`) — amounts are vault-encrypted; the view already EXCLUDES undone rows (`WHERE undone_at IS NULL`), so the transaction CSV + the per-cycle sums naturally exclude cancelled transactions.
> - **`commission`** — the `commission()` domain function (`@/domain/cycle`, INV-4 = `dailyAmount × 1`); NEVER inline.
> - **`final_payout`** — a settled cycle has `cycles.settled_payout`; a non-settled cycle has no actual payout, so export the PROJECTED balance via `computeProjectedFinalBalance(dailyAmount, advances_sum)` (`@/domain/cycle`). Document which is which.
>
> **Pattern alignment:**
> - The re-auth dialog — `DeleteMemberDialog` (Story 2.6) — `supabase.functions.invoke("re-auth", { body: { password, operation_intent } })`, inspect `error.context.status` (401 invalid / 429 rate_limited / else unexpected), proceed on success. Native `<dialog>`, zero new deps.
> - `audit_append_external(p_event_type, p_entity_id, p_entity_table, p_payload)` — SECURITY DEFINER RPC (Story 6.1), allowlist-gated.
> - CSV download — browser-native `Blob` + `URL.createObjectURL` + a programmatic `<a download>` click. NO CSV library.
>
> **What Story 9.3 does NOT ship:**
> - PDF export (FR39 — Growth).
> - Weekly/monthly auto-reports (FR38 — Growth).
> - A server-side export Edge Function — the data is RLS-scoped client reads + client-side CSV generation; the only server touchpoints are the existing `re-auth` Edge Function + the `audit_append_external` RPC.
> - The 4-tab bottom nav / a dedicated "Rapports" tab — the export action lives on the existing `/settings` route (the epics AC: "the settings / data-export screen").
> - Offline export — the export needs a fresh re-auth (network) + current server data; it is an online-only action (gate the button or let the re-auth call fail cleanly offline).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1302-1317`; the rest are spec-derived constraints.

### The export action + re-auth gate

1. **Given** the `/settings` screen, **Then** it shows an "Exporter en CSV" action (a button in its own section, with a one-line explanation that it exports cycle + transaction history for an accountant).

2. **Given** the collector taps "Exporter en CSV", **When** the action starts, **Then** a password re-auth dialog opens (FR5) — native `<dialog>`, a password input, submit + cancel — mirroring `DeleteMemberDialog`.

3. **Re-auth call.** On submit, `supabase.functions.invoke("re-auth", { body: { password, operation_intent: "csv_export" } })`. Inspect the error: HTTP 401 → inline "mot de passe incorrect"; 429 → inline rate-limited copy; other/network → inline unexpected-error copy. On success (200, `{ ok: true }`) → proceed to the export.

4. **The export proceeds only after a 200 re-auth.** A wrong password / rate-limit keeps the dialog open with the inline error and does NOT generate or download anything.

### CSV generation + download

5. **Given** re-auth succeeded, **When** the export runs, **Then** TWO CSV files are generated and downloaded via the browser:
   - `safaricash-cycles-{YYYY-MM-DD}.csv`
   - `safaricash-transactions-{YYYY-MM-DD}.csv`

6. **Cycle-summary CSV columns** (exact order): `cycle_id, member_name, cycle_start_date, cycle_end_date, total_contributions, advances_sum, commission, final_payout, status`.
   - `total_contributions` = Σ `amount` of the cycle's `contribution` + `rattrapage` transactions.
   - `advances_sum` = Σ `amount` of the cycle's `advance` transactions.
   - `commission` = `commission(member.dailyAmount)` from `@/domain/cycle`.
   - `final_payout` = `cycles.settled_payout` when the cycle is `settled`; otherwise `computeProjectedFinalBalance(member.dailyAmount, advances_sum)` (the projected balance).
   - `status` = the raw `cycles.status` value (`active` / `with_advance` / `completed` / `settled`).
   - One row per cycle, all the collector's cycles (every status).

7. **Transaction-history CSV columns** (exact order): `transaction_id, date, kind, amount, member_id, member_name`.
   - `date` = the transaction's `created_at`.
   - One row per non-undone transaction (the `transactions_decrypted` view already excludes undone).

8. **CSV correctness.** A proper header row; RFC-4180-style escaping — any field containing `,`, `"`, or a newline is wrapped in double quotes with internal `"` doubled (member names can contain commas/quotes). UTF-8. The escaping/serialisation MUST be a pure, separately-tested function (do not inline it in the hook).

9. **Download mechanism.** Browser-native — `new Blob([csv], { type: "text/csv;charset=utf-8" })` → `URL.createObjectURL` → a programmatic `<a download={filename}>` click → `URL.revokeObjectURL`. No CSV/file-saver dependency.

10. **Empty data.** A collector with zero cycles / zero transactions still gets well-formed CSVs (header row only). The action does not error.

### Audit event

11. **Given** the CSVs were generated, **Then** an `export.csv_generated` audit event is recorded via `audit_append_external` — `entity_id` = the collector's own user id, `entity_table` = `'users'`, `payload` = `{ cycles_count, transactions_count }`.

12. **Migration — extend the `audit_append_external` allowlist.** The RPC's `event_type` allowlist currently permits only `'sms.queued'`. `CREATE OR REPLACE` the function (no signature change → no DROP needed) with `'export.csv_generated'` added to the `IN (...)` list. Update the function comment.

13. **Audit failure is non-fatal to the download.** If the `audit_append_external` call fails (network), the CSVs have already downloaded — surface a non-blocking warning toast; do NOT claim the export failed. (The audit is best-effort client-side — documented limitation.)

### Tests

14. **Unit — CSV serialisation** (`buildCsv` / the escaping fn): header + rows; fields with commas / quotes / newlines escaped per RFC 4180; empty rows → header only; ≥ 8 cases.

15. **Unit — the cycle-summary derivation**: `total_contributions` (contribution+rattrapage), `advances_sum`, `commission` via the domain fn, `final_payout` settled-vs-projected branch, every-status coverage. Pure + separately tested.

16. **Unit — the export hook / orchestration**: re-auth-success path triggers fetch → build → download → `audit_append_external`; an audit failure does not throw; offline / re-auth-failure does not download.

17. **Unit — the re-auth dialog**: 401 → invalid copy; 429 → rate-limited copy; success → the export runs; cancel closes; `axe`-clean.

18. **Deno contract test** — `audit_append_external` accepts `'export.csv_generated'` (was rejected before the migration) and writes a chain-valid `audit_log` row; registered in `scripts/run-edge-tests.sh`.

19. **Playwright E2E** — `tests/e2e/flow-9-csv-export.spec.ts`: seed a collector with cycles + transactions; `/settings` → "Exporter en CSV" → wrong password → inline error, no download → correct password → assert two CSV downloads occur (Playwright `page.waitForEvent("download")` ×2) and their content (header + a known row) → assert an `export.csv_generated` row landed in `audit_log`.

### Architecture, dependencies, hygiene

20. **No new npm dependencies.** `Blob` / `URL.createObjectURL` / `<a download>` are browser-native; `supabase.functions.invoke` + `supabase.rpc` already in the bundle.

21. **Layering.** New code in a `src/features/export/` feature (`api/` + `ui/`). It may import `commission` / `computeProjectedFinalBalance` from `@/domain/cycle`, `supabase` from `@/infrastructure/supabase`, and `formatAmount` helpers. The route stays `src/app/routes/settings.tsx`.

22. **i18n.** All copy through new `settings.export.*` (or `export.*`) keys in `src/i18n/fr.json` — the action label + explanation, the re-auth dialog copy + error states, the audit-failed warning toast. No hard-coded French.

23. **All gates green**:
    - `npm run typecheck` — strict clean.
    - `npm run lint --max-warnings=0` — clean.
    - `npm run test -- --coverage` — global ≥ 75 % branches; the new CSV-serialisation + cycle-derivation modules ≥ 85 % branches isolated.
    - `npm run test:edge` — Deno contract tests pass incl. the new `audit_append_external` `export.csv_generated` case.
    - `npm run build` — bundle delta ≤ 5 KB gzipped.
    - `npx playwright test` — the new csv-export flow + all existing flows; full suite locally on Node 22.
    - **Pre-push memory**: `nvm use 22` (`feedback_npm_lockfile_node_version.md`); coverage locally (`feedback_run_coverage_locally.md`); the migration touches an RPC body — `psql` smoke-test OR `test:edge` before push (`feedback_migration_rpc_smoke_test.md`); grep stale assertions (`feedback_push_then_ci_failure.md`).

## Tasks / Subtasks

- [x] **Task 1 — Migration: extend the `audit_append_external` allowlist** (AC: #12, #18)
  - `npm run db:migrate:new audit-allow-export-csv-generated` — `CREATE OR REPLACE public.audit_append_external` with `'export.csv_generated'` added to the event-type `IN (...)` allowlist; update the comment; re-`GRANT` if the CREATE OR REPLACE drops it (it does not — but verify).
  - `npm run db:migrate` (NOT `db:reset`); regenerate `database.types.ts`.
  - Smoke-test via `psql` before push.

- [x] **Task 2 — Deno contract test** (AC: #18)
  - `supabase/functions/_shared/audit-export-event.contract.test.ts` — `audit_append_external('export.csv_generated', …)` succeeds + writes a chain-valid row; register in `scripts/run-edge-tests.sh`.

- [x] **Task 3 — Pure CSV serialisation module** (AC: #8, #9, #14)
  - `src/features/export/api/buildCsv.ts` — `toCsv(headers, rows)` with RFC-4180 escaping; `triggerCsvDownload(filename, content)` (Blob + objectURL + `<a>` click + revoke).
  - `buildCsv.test.ts` — ≥ 8 cases.

- [x] **Task 4 — Export-data fetch + cycle-summary derivation** (AC: #6, #7, #10, #15)
  - `src/features/export/api/deriveExportRows.ts` — pure: cycles + members + transactions → the cycle-summary rows + the transaction rows. `total_contributions` / `advances_sum` / `commission` / `final_payout`.
  - `deriveExportRows.test.ts`.
  - The fetch (cycles + `members_decrypted` + `transactions_decrypted`) — a function in `src/features/export/api/`.

- [x] **Task 5 — `useCsvExport` orchestration hook** (AC: #5, #10, #11, #13, #16)
  - Fetch → derive → build the 2 CSVs → trigger 2 downloads → `audit_append_external` (best-effort). Returns an in-progress + error/warning state.

- [x] **Task 6 — Re-auth dialog** (AC: #2, #3, #4, #17)
  - `src/features/export/ui/CsvExportReauthDialog.tsx` — mirror `DeleteMemberDialog`'s re-auth call (`operation_intent: "csv_export"`); on 200 → run `useCsvExport`.

- [x] **Task 7 — Settings route wiring** (AC: #1)
  - `src/app/routes/settings.tsx` — add the "Exporter en CSV" section + mount the dialog.

- [x] **Task 8 — i18n** (AC: #22)
  - New `settings.export.*` keys.

- [x] **Task 9 — Playwright E2E + gate run + sprint hygiene** (AC: #19, #23)
  - `tests/e2e/flow-9-csv-export.spec.ts`.
  - All gates green on Node 22 / npm 10; full Playwright suite before push.
  - `sprint-status.yaml`: `9-3-csv-export` `ready-for-dev → review`; `last_updated` + touched line.

### Review Findings

> Cross-LLM adversarial review 2026-05-16 (claude-sonnet-4-6, 3 layers: Blind Hunter / Edge Case Hunter / Acceptance Auditor). 1 decision-needed (resolved → keep plain UTF-8) + 2 patch + 16 dismissed as noise.

- [x] [Review][Decision] UTF-8 BOM for Excel compatibility — RESOLVED: keep plain UTF-8 with no BOM (conforms to AC #8's literal "UTF-8"; avoids BOM-intolerant parsers). Excel-on-Windows users import via the UTF-8 encoding picker.
- [x] [Review][Patch] `triggerCsvDownload` — clean up the anchor + object URL even if `anchor.click()` throws (wrapped click→remove→revoke in try/finally) [src/features/export/api/buildCsv.ts:42-45] — FIXED
- [x] [Review][Patch] `deriveExportRows.test.ts` — added a `final_payout` assertion proving a `completed` (non-settled) cycle uses `computeProjectedFinalBalance` [src/features/export/api/deriveExportRows.test.ts] — FIXED

## Dev Notes

### Re-auth is password — the `re-auth` Edge Function already exists

`supabase/functions/re-auth/` accepts `{ password, operation_intent }` where `operation_intent` ALREADY includes `"csv_export"`. It verifies via `signInWithPassword` under a throwaway client, returns `{ ok: true }` (200) or RFC-7807 errors (401 credentials_invalid, 429 rate_limited, 400 request_invalid); rate-limiting is Supabase-Auth server-side. The `DeleteMemberDialog` (Story 2.6) is the exact client pattern — `supabase.functions.invoke("re-auth", …)`, branch on `error.context.status`. Copy it. Do NOT build an OTP flow (the epics "OTP verified" wording predates PRD v1.3's password switch).

### How `export.csv_generated` reaches `audit_log`

`audit_append_external(p_event_type, p_entity_id, p_entity_table, p_payload)` is a SECURITY DEFINER RPC (Story 6.1) that canonical-serialises + hash-chains an audit row exactly like the table-trigger `audit_emit()`. Its event-type allowlist is currently `IN ('sms.queued')` — Task 1 extends it. The client calls it (`supabase.rpc("audit_append_external", …)`) after the downloads, with `entity_id` = the collector's own `auth.uid()`, `entity_table = 'users'`, `payload = { cycles_count, transactions_count }`. It is best-effort (AC #13) — a failed audit call must not present the (already-completed) export as failed.

### Why client-side CSV + no export Edge Function

The export data is the collector's OWN, RLS-scoped — the client can already read it. CSV generation is pure string work. The architecture (`architecture.md:340`) says no server-side aggregation at MVP. So: the only server touchpoints are the `re-auth` gate (verifies the password) and the `audit_append_external` RPC (records the event). No new Edge Function.

### `final_payout` — settled vs projected

A `settled` cycle has the real `cycles.settled_payout`. A non-settled cycle has none — export `computeProjectedFinalBalance(dailyAmount, advances_sum)` (the same projection the saver receipt shows). The CSV column is one number per row; document in the spec/code which cycles carry a projection vs a settled figure (a future enhancement could add a `payout_kind` column — out of scope).

### CSV escaping — member names are user input

Member names are free text → may contain `,` `"` newlines. The serialiser MUST RFC-4180-escape every field (wrap in `"`, double internal `"`). A naïve `fields.join(",")` would corrupt the file. Pure + unit-tested (AC #8/#14).

### Code-reuse map

| Need | Existing implementation |
|---|---|
| Password re-auth dialog + `re-auth` invoke | `DeleteMemberDialog` (Story 2.6) |
| `re-auth` Edge Function (`operation_intent: "csv_export"`) | `supabase/functions/re-auth/` |
| External audit event | `audit_append_external` RPC (Story 6.1) |
| `commission` / `computeProjectedFinalBalance` | `@/domain/cycle` |
| Decrypted reads | `members_decrypted` / `transactions_decrypted` views |
| FCFA formatting (if shown in UI) | `@/features/member/api/formatAmount` |
| Native `<dialog>` modal pattern | `SettlementReauthDialog` / `DeleteMemberDialog` |

### Anti-patterns to avoid

- **DO NOT** build an OTP re-auth — it is password (PRD v1.3).
- **DO NOT** add a CSV / file-saver npm dependency — `Blob` + `<a download>` is native.
- **DO NOT** inline CSV escaping — pure, RFC-4180, tested.
- **DO NOT** inline `dailyAmount × 1` — use `commission()`.
- **DO NOT** build a server-side export Edge Function — client-side derivation.
- **DO NOT** present a failed `audit_append_external` as a failed export (the files already downloaded).
- **DO NOT** forget to extend the `audit_append_external` allowlist — the RPC silently rejects unlisted event types.
- **DO NOT** push the migration without a `psql`/`test:edge` smoke test (`feedback_migration_rpc_smoke_test.md`).
- **DO NOT** `npm install` on Node 24/npm 11 — `nvm use 22`.

### Project structure notes

**New files:**
- `supabase/migrations/<timestamp>_audit_allow_export_csv_generated.sql`
- `supabase/functions/_shared/audit-export-event.contract.test.ts`
- `src/features/export/api/buildCsv.ts` (+ `.test.ts`)
- `src/features/export/api/deriveExportRows.ts` (+ `.test.ts`)
- `src/features/export/api/useCsvExport.ts` (+ `.test.tsx`)
- `src/features/export/ui/CsvExportReauthDialog.tsx` (+ `.test.tsx`)
- `tests/e2e/flow-9-csv-export.spec.ts`

**Modified files:**
- `src/app/routes/settings.tsx` — the "Exporter en CSV" section + dialog.
- `scripts/run-edge-tests.sh` — register the new contract file.
- `src/infrastructure/supabase/database.types.ts` — regenerated.
- `src/i18n/fr.json` — `settings.export.*` keys.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

### Testing standards

- Vitest + RTL; pure-module unit tests for `buildCsv` + `deriveExportRows`; `vi`-mock `supabase` for the hook + dialog; the download is tested by spying on `URL.createObjectURL` / the `<a>` click.
- Deno contract test for the migration (`test:edge`).
- Playwright for the E2E (`page.waitForEvent("download")`).
- Coverage: ≥ 75 % branches global; the CSV + derivation modules ≥ 85 % isolated.

### Definition-of-done checklist

- All 23 ACs satisfied + all 9 tasks ticked.
- `/settings` exports two correct, RFC-4180 CSVs behind a password re-auth.
- `export.csv_generated` lands in `audit_log` (allowlist extended + chain-valid).
- All gates green on Node 22 / npm 10; full Playwright suite run locally before push.
- Story status `review`; sprint-status updated; touched-line updated.
- **Epic 9 (Dashboard & Activity Visibility) is complete — 3/3 stories.**

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **Migration regression caught pre-push.** The first draft of `20260516000001` reproduced migration 0036's body byte-for-byte — but 0036's allowlist is `('sms.queued')` only. Migrations 0044/0046/0051 had since extended it to 6 sms.* events. A `CREATE OR REPLACE` from the 0036 baseline would have silently un-allowlisted `sms.sent/failed/abandoned/opt_out/resend_initiated`, breaking the SMS worker. Fixed by rebasing the body on migration 0051 (the latest extend) and re-smoke-testing all 7 event types.
- **E2E 400 — `cycles.settled_payout` does not exist.** `runCsvExport` initially selected `settled_payout` from `cycles` (per the spec's "Data sources"). PostgREST returned 400; `cycles` has only `settled_at`, no `settled_payout`. The realised payout of a settled cycle is the `amount` of its synthetic `kind='settlement'` transaction (migration 0064). Reworked `deriveCycleSummaryRows` to read the settlement-tx amount; `ExportCycle` dropped its `settled_payout` field.
- **`node_modules` clobbered by Deno.** Running `test:edge` with `--node-modules-dir=auto` rewrote `node_modules` (vitest 4.1.6→4.1.5, a stray `.deno/` tree), breaking `vitest`'s `vite` resolution. Restored with `npm ci` on Node 22.

### Completion Notes List

- **SCHEMA DEVIATION (AC #6, #12 wording).** The story spec stated `cycles` has a `settled_payout` column; it does not. `final_payout` for a `settled` cycle is the amount of that cycle's `kind='settlement'` transaction (from `transactions_decrypted`); non-settled cycles export `computeProjectedFinalBalance`. Behaviourally identical to the spec's intent — the settled payout is still the real figure — just sourced correctly.
- **`useCsvExport` is a plain async function** (`runCsvExport`), not a React hook. The dialog (`CsvExportReauthDialog`) owns the in-progress/error state; the orchestration needs no React state of its own, so a hook would add ceremony without benefit.
- **Audit is best-effort (AC #13).** `runCsvExport` returns `auditFailed`; the dialog toasts a non-blocking warning rather than presenting a failed export — the CSVs have already downloaded.
- **`test:edge` — the new `audit-export-event.contract.test.ts` passes 2/2.** Two pre-existing local failures (`sms-inbound` STOP-keyword, `sms-worker` real-Termii 4xx) are Termii-network-dependent, unrelated to Story 9.3.
- **Playwright — `flow-9-csv-export` green.** `flow-1-record-rattrapage`, `flow-3-cycle-settlement`, `receipt-url-worker` fail locally — verified failing identically on a clean `main` checkout (seed-data-state + un-started wrangler workers); not a Story 9.3 regression. CI seeds a fresh Supabase stack.
- **`database.types.ts` NOT regenerated** — the migration is a `CREATE OR REPLACE` with an unchanged signature; the generated RPC types are byte-identical, so a regen would be a no-op (and `db:types` needs a linked remote project).

### File List

**New:**
- `supabase/migrations/20260516000001_audit_allow_export_csv_generated.sql`
- `supabase/functions/_shared/audit-export-event.contract.test.ts`
- `src/features/export/api/buildCsv.ts` (+ `.test.ts`)
- `src/features/export/api/deriveExportRows.ts` (+ `.test.ts`)
- `src/features/export/api/runCsvExport.ts` (+ `.test.ts`)
- `src/features/export/ui/CsvExportReauthDialog.tsx` (+ `.test.tsx`)
- `src/features/export/index.ts`
- `tests/e2e/flow-9-csv-export.spec.ts`

**Modified:**
- `src/app/routes/settings.tsx` — the "Exporter en CSV" section + dialog mount.
- `src/i18n/fr.json` — `settings.export.*` keys.
- `scripts/run-edge-tests.sh` — registered the new contract test.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## References

- **Epic spec:** `epics.md` lines 391-399 (Epic 9), 1302-1317 (Story 9.3 BDD).
- **PRD:** `prd.md` — FR37 ("a collector can export their cycle-level commission summary and transaction history as CSV"), FR5 ("fresh password re-authentication … before cycle settlement, bulk member delete, and data export"), v1.3 amendments (password re-auth, not OTP), line 290 (tax/export context — CSV at MVP).
- **Architecture:** `architecture.md` line 351 (the re-auth Edge Function), 359 (audit-emit triggers), 340 (no server-side aggregation at MVP), 325 (CSV export at MVP).
- **UX spec:** `ux-design-specification.md` — the "Rapports" tab + the danger-zone "explicit acknowledgment" pattern for data export; the export action lives on `/settings` for this story.
- **Existing code:** `supabase/functions/re-auth/` (the re-auth Edge Function contract), `src/features/member/ui/DeleteMemberDialog.tsx` (the re-auth client pattern), `supabase/migrations/20260427000005_audit_append_external.sql` (the RPC + allowlist), `src/domain/cycle/cycleEngine.ts` (`commission`, `computeProjectedFinalBalance`), `supabase/migrations/20260514000005_commit_cycle_settlement.sql` (`cycles.settled_payout`), `src/app/routes/settings.tsx` (the route to extend).
- **CLAUDE.md:** tokens not hex; layering; `db:migrate` not `db:reset`; no new deps for trivial needs.
- **Memory:** `feedback_migration_rpc_smoke_test.md`, `feedback_npm_lockfile_node_version.md`, `feedback_run_coverage_locally.md`, `feedback_push_then_ci_failure.md`, `project_supabase_rpc_binding.md`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-16 | Story 9.3 drafted via bmad-create-story — THIRD and FINAL story of Epic 9. A password-gated "Exporter en CSV" action on `/settings`: tapping it opens a re-auth dialog → the existing `re-auth` Edge Function verifies the password (`operation_intent: "csv_export"`) → on 200, the client fetches the collector's cycles + members + transactions (RLS-scoped, decrypted views), derives two CSVs (cycle summaries + transaction history) with RFC-4180 escaping, triggers two browser downloads (Blob + `<a download>`), and records an `export.csv_generated` audit event via `audit_append_external`. One migration extends that RPC's event-type allowlist (currently `sms.queued`-only). `commission` uses the domain function; `final_payout` is `settled_payout` for settled cycles else the projected balance. CSV serialisation + the cycle-summary derivation are pure, separately-tested modules. NO new deps; NO server-side export Edge Function — client-side derivation, the only server touchpoints are the existing re-auth gate + the audit RPC. Re-auth is PASSWORD (PRD v1.3) — the epics "OTP" wording is stale. 23 ACs / 9 tasks. Closes Epic 9. | Spec author (claude-opus-4-7[1m]) |
| 2026-05-16 | Story 9.3 implemented via bmad-dev-story on `feat/9-3-csv-export` — 9 tasks / 23 ACs. New `src/features/export/` feature: `buildCsv` (RFC-4180 serialiser + browser-download trigger), `deriveExportRows` (pure cycle-summary + transaction-row derivation), `runCsvExport` (orchestration), `CsvExportReauthDialog` (password re-auth, mirrors `DeleteMemberDialog`). Migration `20260516000001` extends the `audit_append_external` allowlist with `export.csv_generated` (body rebased on migration 0051 — keeps all sms.* events; psql-smoke-tested + a Deno contract test). SCHEMA DEVIATION: `cycles` has no `settled_payout` column — a settled cycle's `final_payout` is the amount of its `kind='settlement'` transaction; non-settled cycles export the projection. Gates green: typecheck / lint / 942 vitest (76.25% branches) / build / `test:edge` (new contract test green) / Playwright `flow-9-csv-export` green. Closes Epic 9 (3/3). | Dev agent (claude-opus-4-7[1m]) |
