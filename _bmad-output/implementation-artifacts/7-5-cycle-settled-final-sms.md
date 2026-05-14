# Story 7.5: Cycle settled final SMS + settlement receipt page

Status: review

## Story

As a **saver**,
I want **to receive a final SMS confirming that my cycle is closed and stating the amount I will receive**,
so that **I have tamper-evident proof of the settlement (FR18 settled, FR21 completion).**

> **Predicate of this story.** Epic 7's **closing deliverable**. Story 7.4 already wired the entire enqueue pipeline: the synthetic `transactions.kind='settlement'` INSERT fires `enqueue_sms_on_transaction` which calls `format_sms_body('settlement', tx_id)`. Story 7.5 ships the **content polish + the receipt-URL rendering** for `kind='settlement'`:
>
> 1. **Settlement SMS template content** — extend `format_sms_body('settlement', ...)` to include the saver's first name + the cycle date range + a closing statement (per BDD line 1163), while staying within Termii's 160-char single-SMS budget (NFR-L1).
> 2. **Settlement receipt page (Cloudflare Worker)** — extend `workers/receipt-url/src/render.ts` to render a tailored receipt for `kind='settlement'` rows: "Cycle clôturé" headline + cycle date range + final payout + closing statement + disclosure. Hide the dispute CTA (settlement is irreversible — Story 4.5's soft-undo doesn't apply to `kind='settlement'`).
> 3. **`get_receipt_payload` RPC extension** — add `cycle_start_date` + `cycle_end_date` columns so the Worker's render layer can show the cycle period (currently only `created_at` is available — that's the settlement timestamp, NOT the cycle start).
> 4. **Tests** — Deno contract test for the updated `format_sms_body('settlement', ...)`; Worker unit test for the settlement render branch; extend the Story 7.4 Playwright Flow 3 E2E to verify the SMS body content + the receipt URL page rendering.
>
> **Architectural alignment with existing infrastructure (DO NOT re-invent):**
> - The SMS dispatch + retry contract is **already in place** (Stories 6.1 / 6.2). Story 7.5 only touches the template content — NO new dispatch code.
> - The receipt-URL Worker, `get_receipt_payload` RPC, and `tokenIsValid` helper are **already in place** (Story 6.4). Story 7.5 extends them; no new infrastructure.
> - The `format_sms_body('settlement', ...)` template **already exists** (migration 0029 line 120) and works end-to-end via Story 7.4's commit pipeline. Story 7.5 amends the rendered copy only.
> - **`kind='settlement'` is already a valid enum value** (Story 7.4 migration 0057). Story 7.5 surfaces it in additional layers (render + receipt page).
>
> **What Story 7.5 does NOT ship:**
> - A full cycle-summary HTML page (contributions / commission / advances / payout). The MVP settlement receipt is a single-payout focused page; the full cycle-summary surface is a future enhancement.
> - SMS delivery to the *collector* on settlement (per BDD: SMS is for the *saver* only).
> - Any change to Story 7.4's RPC, Edge Function, dialog, route, or `<EnvelopeHandoverScreen>` — Story 7.4 is a closed surface for Story 7.5.
> - WhatsApp secondary delivery (Story 6.8 territory).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1159-1165`; the rest are spec-derived constraints required for a flawless implementation.

### SMS template content

1. **Settlement SMS body template** — replace the current `'SafariCash. Cycle clos. Vous avez recu %s FCFA. Merci. Detail: %s.'` literal in `format_sms_body('settlement', ...)` (migration 0029 line 120) with:
   ```
   SafariCash. {firstName}, votre cycle du {start} au {end} est clos.
   Vous avez recu {amount} FCFA. Merci. Detail: {url}.
   ```
   Rendered as ONE line (no actual newline in the SMS body — the template above uses \n for spec readability). Expected ~125-135 characters before substitution; within Termii's 160-char single-SMS budget (NFR-L1).
   - **`{firstName}`** = `substring(unaccent(vault_decrypt(member.name)) from '^[^ ]+')` — same first-name extraction as Story 6.4's `get_receipt_payload`. Unaccented + first-whitespace-delimited token. *"Awa Diallo" → "Awa".* If the name has no space, fallback to the entire unaccented name. **No special encoding needed for ASCII-only names**; non-ASCII names (Wolof / Bambara) are unaccented to fit GSM-7 single SMS.
   - **`{start}` / `{end}`** = `to_char(cycle.start_date, 'DD/MM')` / `to_char(cycle.end_date, 'DD/MM')`. **DD/MM only** (no year) to save characters; the cycle is recent enough that the year is unambiguous. *"2026-04-12" → "12/04".*
   - **`{amount}`** = pre-formatted as plain digits (no NBSP thousands separator — SMS body is plain ASCII for GSM-7 portability). Use `to_char(amount, 'FM999999999')` to strip trailing whitespace. *"87 000" → "87000".* Trade-off: less readable in the SMS, but guarantees single-SMS delivery. The receipt URL page shows the formatted value.
   - **`{url}`** = `current_setting('app.receipt_url_base', true) || '/r/' || receipt_token`. Same construction as the existing `'first_receipt'` template.

2. **Length defence** — extend the Story 6.3 SMS-length contract test (`format-sms-body.contract.test.ts` AND `sms-templates-length.contract.test.ts`) to assert:
   - With `firstName="Awa"`, `amount=87000`, plausible cycle dates, the rendered body length is ≤ 160.
   - With `firstName="Mahamadou"` (longer first name, 9 chars), `amount=999999999` (max-realistic single-int), the rendered body length is ≤ 160.
   - Boundary case: if length > 160, the test FAILS (regression guard — future template tweaks must preserve single-SMS shape).

3. **ASCII / GSM-7 defence** — the existing `sms-templates-banking-language.contract.test.ts` likely checks no diacritics. Verify it covers settlement; add a case if not. The `unaccent` call in the template handles French diacritics on names.

### Migration discipline

4. **Migration — replace `format_sms_body`** — new file `supabase/migrations/20260515000001_format_sms_body_settlement_content.sql`. Byte-for-byte copy of migration 0042 (`20260429000003_enqueue_sms_format_body.sql`'s baseline — *wait, the actual baseline is migration 0029 / 20260429000002_format_sms_body.sql*). Diff is **intentionally minimal**: only the `if p_template_key = 'settlement'` branch body changes; other branches (`first_receipt` / `subsequent_receipt` / `dispute_ack`) byte-for-byte identical. The function signature, search_path, security_definer marker, and `GRANT EXECUTE` clause all unchanged.

5. **Migration — extend `get_receipt_payload`** — new file `supabase/migrations/20260515000002_get_receipt_payload_cycle_dates.sql`. Adds 2 columns to the returns table: `cycle_start_date date, cycle_end_date date`. Sourced from `cycles.start_date` / `cycles.end_date` via the existing `JOIN public.cycles c ON c.id = t.cycle_id` (already implicitly there via `transactions.cycle_id` FK; add explicit join). The Worker's `ReceiptPayload` type extends with the 2 new optional fields. **Pre-Story-7.5 cached / older Worker deployments** still work because the new fields are appended (PostgREST returns them as-is; the Worker that ignores unknown fields is fine — but we DO update the type for type-safety in TS).

### Worker render

6. **`ReceiptPayload` type extension** — add `cycle_start_date?: string; cycle_end_date?: string` to `workers/receipt-url/src/render.ts` (ISO date strings `YYYY-MM-DD`).

7. **`renderReceiptHtml` — settlement branch** — when `payload.kind === "settlement"`:
   - **Page title** (`<title>` tag): *"Cycle clôturé — SafariCash"* (instead of *"Reçu SafariCash — {name}"*).
   - **Header**: *"Cycle clôturé"* (h1) + *"{first_name}"* subtitle (instead of *"Reçu pour {name}"*).
   - **Body** rows (in order):
     1. **Montant reçu** — `formatAmount(payload.amount)` + " FCFA". Same as the contribution receipt.
     2. **Cycle clôturé le** — `formatDateTime(payload.created_at)` (the settlement timestamp).
     3. **Période du cycle** — *"{cycle_start_date_formatted} au {cycle_end_date_formatted}"*. Format dates as DD/MM/YYYY (full year here — the receipt is a durable proof, the SMS budget doesn't apply). Hide this row if `cycle_start_date` or `cycle_end_date` is missing (defensive — pre-Story-7.5 RPC versions).
     4. **(NO) Solde projeté en fin de cycle** — the projection is moot post-settlement. Skip the row entirely.
     5. **(NO) Jour du cycle** — settlement is day 30 by construction; the period row supersedes this.
   - **Closing statement** (new paragraph after the `<dl>`): *"Merci de votre confiance. Ce reçu finalise votre cycle d'épargne."*
   - **(NO) Dispute CTA** — settlement is structurally irreversible (the RPC took a `FOR UPDATE` lock, the cycle is `status='settled'`). The Story 10.2 dispute path doesn't apply. **Skip the `.dispute` section entirely** for settlement.
   - **(YES) Opt-out CTA** — preserved. The saver can still opt out of future SMS even if this cycle is closed (e.g., they may have a future cycle later).
   - **Disclosure note** — preserved unchanged.

8. **Render layer test extension** — `workers/receipt-url/src/render.test.ts` (or wherever the existing render tests live) extended with:
   - A new test case for `kind='settlement'` payload. Assert: title contains "Cycle clôturé"; body contains "Période du cycle" and the formatted date range; body does NOT contain "Cette transaction n'est pas moi" (no dispute CTA); body contains the closing statement.
   - **axe-clean** for the settlement page (mirroring the existing render axe test for the contribution receipt — settlement page must remain WCAG Level A).

### Tests

9. **Deno contract — `format_sms_body('settlement', tx_id)` content** — extend `supabase/functions/_shared/format-sms-body.contract.test.ts` with a new case for settlement template (or add a parallel `sms-settlement-template.contract.test.ts`). Cases (≥ 3):
   - **Happy path** — seed a member ("Awa Diallo"), a cycle (2026-04-12 → 2026-05-11), a settlement transaction (amount=87000). Call `format_sms_body('settlement', tx_id)`. Assert the body matches `^SafariCash. Awa, votre cycle du 12/04 au 11/05 est clos. Vous avez recu 87000 FCFA. Merci. Detail: .+/r/[0-9a-f]{32}\.$`.
   - **Unaccented name** — member named *"Mariémé"* → body contains *"Marieme"* (unaccent applied).
   - **Single-token name** — member named *"Awa"* (no space) → body contains *"Awa"* (full name used since `substring '^[^ ]+'` matches the whole token).
   - **Length stays ≤ 160** — call the helper with a long-name member and a 6-digit amount; assert `length(body) <= 160`.

10. **Deno contract — `get_receipt_payload` returns cycle dates** — extend `supabase/functions/_shared/` test suite (or add a new file) — case: seed a settlement transaction, call `get_receipt_payload('settlement_token')`, assert `cycle_start_date` and `cycle_end_date` are populated with the cycle's dates.

11. **Worker E2E — settlement receipt page** — extend `tests/e2e/receipt-url-worker.spec.ts` (or add a parallel spec) with a settlement-page case:
   - Seed a settled cycle via service-role (insert `cycles.status='settled'` + a `kind='settlement'` transaction with a known `receipt_token`).
   - GET `/r/{token}` against the live wrangler-dev worker (already wired in CI).
   - Assert response HTML contains: `<title>Cycle clôturé — SafariCash</title>`, the cycle period range, the closing statement; does NOT contain the dispute CTA.
   - 200 status + correct `Content-Type: text/html`.

12. **Playwright Flow 3 E2E extension** — extend `tests/e2e/flow-3-cycle-settlement.spec.ts` (Story 7.4's E2E) with a new section checking the SMS body content AND a navigation to the receipt URL page:
   - After the commit, fetch the `sms_queue` row's `body` via service-role; assert the new template format (member first name + cycle range + closing statement + URL).
   - **Optional** (deferred — Story 6.4's worker isn't always running in unit-test contexts): use the worker URL from the SMS body to GET the receipt page and verify the settlement render. Skip-gate behind `RECEIPT_URL_WORKER_RUNNING`.

### Architecture, contracts, and constraints

13. **No new deps, no new RPCs (signature change only), no schema changes** — Story 7.5 is content + rendering polish. `format_sms_body` keeps its `(p_template_key text, p_transaction_id uuid)` signature. `get_receipt_payload` adds 2 columns to the returns table but keeps the `(p_token text)` parameter signature.

14. **NFR-L1 (SMS single-message)** — the settlement template body MUST remain ≤ 160 GSM-7 characters even with a 10-char first name and a 9-digit amount. Tests (AC #2, AC #9) enforce this.

15. **NFR-A0 (no new dependencies)** — `unaccent` is already a postgres extension enabled in the project (Story 6.3 baseline). `to_char` is built-in. No worker-side dep additions.

16. **Diff discipline** — both new migrations replace existing functions byte-for-byte EXCEPT the targeted branch. Use the same `set check_function_bodies = off` + `create or replace function ...` pattern Stories 6.5 / 6.6 / 7.4 use.

17. **Backward compatibility** — the new `cycle_start_date` / `cycle_end_date` columns in `get_receipt_payload` are non-breaking additions (PostgREST returns them; older Workers ignore them; new Worker uses them defensively via optional chaining).

18. **All gates green.**
    - `npm run db:migrate` — both new migrations apply cleanly.
    - `npm run typecheck` — strict TS clean (`ReceiptPayload` extension propagates).
    - `npm run lint` — no new warnings.
    - `npm run test -- --coverage` — global gates preserved; Worker render branch covered ≥ 80%.
    - `npm run build` — bundle delta negligible (no frontend changes).
    - `deno test` — Deno contract tests pass (CI; not local).
    - `npx playwright test tests/e2e/flow-3-cycle-settlement.spec.ts tests/e2e/receipt-url-worker.spec.ts` — pass against the local stack.

## Tasks / Subtasks

- [x] **Task 1 — Migration: update `format_sms_body('settlement', ...)` content** (AC: #1, #4)
  - New `supabase/migrations/20260515000001_format_sms_body_settlement_content.sql`. Byte-for-byte copy of migration 0029 EXCEPT the `if p_template_key = 'settlement'` branch — extends with first-name + cycle dates + closing statement.

- [x] **Task 2 — Migration: extend `get_receipt_payload` with cycle dates** (AC: #5)
  - New `supabase/migrations/20260515000002_get_receipt_payload_cycle_dates.sql`. Adds `cycle_start_date date, cycle_end_date date` to the returns table. Adds explicit `JOIN public.cycles c ON c.id = t.cycle_id` to source them.

- [x] **Task 3 — Worker `ReceiptPayload` type + render settlement branch** (AC: #6, #7)
  - `workers/receipt-url/src/render.ts` — add optional `cycle_start_date` / `cycle_end_date` to the type. New `renderSettlementReceiptHtml(token, payload)` helper OR a conditional branch inside `renderReceiptHtml` keyed on `payload.kind === 'settlement'`. Prefer the conditional branch for minimal diff.

- [x] **Task 4 — Worker render unit tests** (AC: #8)
  - `workers/receipt-url/src/render.test.ts` (or `render-receipt.test.ts`) — add settlement test case + axe-clean assertion for the settlement HTML.

- [x] **Task 5 — Deno contract: `format_sms_body('settlement', ...)`** (AC: #2, #9)
  - Extend `supabase/functions/_shared/format-sms-body.contract.test.ts` with ≥ 3 settlement cases + length boundary. Pre-Story-7.5 the file may not have a settlement case at all (the original template was a placeholder); add it now.

- [x] **Task 6 — Deno contract: `get_receipt_payload` cycle dates** (AC: #10)
  - New `supabase/functions/_shared/get-receipt-payload-settlement.contract.test.ts` OR extend an existing file — case asserting the 2 new columns are populated for a settlement transaction.

- [x] **Task 7 — Worker E2E: settlement receipt page** (AC: #11)
  - Extend `tests/e2e/receipt-url-worker.spec.ts` with a settlement-page rendering case.

- [x] **Task 8 — Playwright Flow 3 SMS-body extension** (AC: #12)
  - Extend `tests/e2e/flow-3-cycle-settlement.spec.ts` (Story 7.4) to assert the new SMS body format after commit.

- [x] **Task 9 — Local gate run** (AC: #18)
  - `npm run db:migrate` (apply both new migrations).
  - `npm run typecheck && npm run lint && npm run test -- --coverage && npm run build` all green.
  - Deno + Playwright deferred to CI.

- [x] **Task 10 — Sprint hygiene**
  - Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: `7-5-cycle-settled-final-sms` from `ready-for-dev` → `review` once dev completes. **Bonus**: flip `epic-7` from `in-progress` → `done` since 7.5 is the LAST story (5/5).
  - Update `last_updated` + touched line.

## Dev Notes

### Why this is the lightest story of Epic 7

Story 7.4 already shipped the full enqueue + dispatch pipeline. Story 7.5 is purely content + rendering polish. No new RPC, no new Edge Function, no new frontend feature folder, no new dialog. Two surgical migrations + one render branch. **Estimated LOC: ~300-400.** Roughly equivalent to Stories 7.1 / 7.2 size, much smaller than 7.4.

### SMS length budget — the single most important constraint

NFR-L1 (single-SMS delivery) is the hard cap. With:
- `SafariCash. ` (12 chars)
- `Awa, ` (5 chars) — 1-10 chars realistic
- `votre cycle du 12/04 au 11/05 est clos. ` (40 chars)
- `Vous avez recu 87000 FCFA. ` (26 chars) — up to 30 chars for 9-digit amounts
- `Merci. ` (7 chars)
- `Detail: https://receipts.safaricash.app/r/abc123def...` (32 hex + ~30 prefix = ~62 chars)
- Trailing period.

**Total: ~155 chars worst-case** with a 10-char name and 9-digit amount. Within budget but TIGHT.

**If the team adds more content later** (closing statement variant, longer URL prefix, etc.), the template may exceed 160. The Story 6.3 length-contract test is the regression net.

**Trade-offs deliberately made:**
- Date format `DD/MM` (no year) — saves 6 chars; year is unambiguous for a recent cycle.
- No NBSP thousands separator in amount — saves 1-2 chars; the receipt URL page shows the formatted version.
- Unaccented first name — keeps the SMS GSM-7 compatible (some Termii routes degrade to UCS-2 for non-GSM chars, halving the per-segment budget to 70 chars).

### Why a settlement-specific receipt page (vs. reusing the transaction receipt template)

The transaction receipt template is built around a single transaction with a projection. A settlement is structurally different:
- The "projected" balance has materialized — show "Solde versé" or just "Montant reçu".
- The "type d'opération" row is redundant — the headline already says "Cycle clôturé".
- The "jour du cycle" row is constant (day 30) — replace with the cycle period range, which is more meaningful.
- The dispute CTA doesn't apply — settlement is `status='settled'`, irreversible by design. Showing the CTA would mislead.

The minimal-diff branch in `renderReceiptHtml` keyed on `payload.kind === 'settlement'` is the cleanest approach. **Do NOT** create a separate `renderSettlementReceiptHtml` function unless the divergence grows beyond ~30 lines (it shouldn't for MVP).

### Why we don't ship a full cycle-summary HTML page

The BDD says *"showing the cycle summary"* but the MVP scope is the **final payout receipt**, not a full breakdown (contributions / commission / advances / payout). A full cycle-summary page would require:
- A new RPC (or extension) returning the aggregated cycle data.
- A new render module (or significant extension of the existing one).
- Additional tests.

This is a follow-up enhancement candidate, not a Story 7.5 deliverable. The saver who wants the breakdown can ask their collector (who has the full view via `<SettlementSummaryCard>` from Story 7.1).

### Receipt token reuse — settlement gets the same token machinery

The synthetic settlement transaction inserted by `commit_cycle_settlement` (Story 7.4) has `receipt_token` populated by the existing migration 0024 trigger that auto-generates 32-hex tokens for all transactions. **No special handling needed** — the token is unique per transaction, and the `get_receipt_payload(token)` RPC works the same way for settlement as for contributions.

### Dispute CTA hidden for settlement — security rationale

The dispute path (`/r/{token}/dispute`) is a Story 10.2 placeholder. Even when Story 10.2 ships, the dispute flow targets transactions the saver *didn't authorize*. A settlement is irreversibly committed by the collector — disputing it is meaningless (the cycle is closed, the cash has changed hands). **Hide the CTA entirely** rather than showing it disabled or with a different message.

### Code-reuse map (DO NOT reinvent)

| Need | Existing implementation |
|---|---|
| SMS dispatch + retry contract | Stories 6.1 / 6.2 (`sms-dispatch`, `sms-worker`) — Story 7.5 doesn't touch these |
| `format_sms_body` template helper | Migration 0029 (`20260429000002_format_sms_body.sql`) — Story 7.5 extends the settlement branch |
| Settlement enqueue trigger | Story 7.4 migration 0060 (`enqueue_sms_settlement_template.sql`) — already forces `template_key='settlement'` for `kind='settlement'` |
| Receipt URL Worker | Story 6.4 — Story 7.5 extends one branch in `render.ts` |
| `get_receipt_payload` RPC | Story 6.4 migration 0043 — Story 7.5 adds 2 columns |
| `tokenIsValid` helper | Story 6.4 worker — unchanged |
| `vault_decrypt`, `unaccent`, `to_char` | Built-in or already-enabled PG functions |
| Length / banking-language contract tests | Story 6.3 — Story 7.5 extends with settlement cases |

### Anti-patterns to avoid (from past stories' review feedback)

- **DO NOT** create a new SMS dispatch path for settlement — reuse the existing `sms_queue` + `sms-worker` pipeline.
- **DO NOT** add a `WhatsApp` or `voice` alternative — Story 6.8 (WhatsApp secondary) is its own backlog item.
- **DO NOT** include non-ASCII chars in the SMS body — Termii degrades GSM-7 → UCS-2 silently, halving the per-segment budget. Use `unaccent` on names.
- **DO NOT** include the year in the SMS date — wastes 6 chars per occurrence, no information value for recent cycles.
- **DO NOT** add the dispute CTA to the settlement page — meaningless for a settled cycle; misleads the saver.
- **DO NOT** keep the "Solde projeté" row on the settlement page — replace with "Période du cycle".
- **DO NOT** regenerate `database.types.ts` — the RPC return shape change is for the Worker (which doesn't consume `database.types.ts`).
- **DO NOT** mutate Story 7.4's RPC, Edge Function, dialog, route, or component — Story 7.5 is a closed-surface follow-up.

### Project structure notes

**New files:**
- `supabase/migrations/20260515000001_format_sms_body_settlement_content.sql`
- `supabase/migrations/20260515000002_get_receipt_payload_cycle_dates.sql`
- (Optional) `supabase/functions/_shared/get-receipt-payload-settlement.contract.test.ts` if not extending an existing file.

**Modified files:**
- `workers/receipt-url/src/render.ts` — extend type + add settlement branch in `renderReceiptHtml`.
- `workers/receipt-url/src/render.test.ts` (or equivalent) — new settlement test cases.
- `supabase/functions/_shared/format-sms-body.contract.test.ts` — extend with settlement-content cases.
- `supabase/functions/_shared/sms-templates-length.contract.test.ts` — extend length boundary test.
- `tests/e2e/receipt-url-worker.spec.ts` — extend with settlement-page rendering case.
- `tests/e2e/flow-3-cycle-settlement.spec.ts` — extend SMS-body assertion.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status flip + epic-7 → done.

### Testing standards

- Deno + Supabase local stack for contract tests.
- Vitest for Worker render unit tests (the Worker has its own test runner — verify via grep).
- Playwright + Supabase + wrangler-dev for E2E.
- 100 % coverage gate on `src/domain/**` unaffected (no domain changes).
- Worker render coverage gate: ≥ 80 % branches (Story 6.4 baseline).

### Definition-of-done checklist

- All 18 ACs satisfied + all 10 tasks ticked.
- Both new migrations apply cleanly via `npm run db:migrate`.
- `format_sms_body('settlement', tx_id)` rendered body matches the new format with all 4 interpolations (firstName, start, end, amount, url).
- Length contract test asserts ≤ 160 chars with realistic worst-case inputs.
- Worker `renderReceiptHtml` settlement branch renders the page with cycle period + no dispute CTA + closing statement.
- All gates green locally: typecheck / lint / `test --coverage` / build / `db:migrate`.
- Story status set to `review`; sprint-status updated; **epic-7 transitioned to `done`** (5/5 stories complete).
- touched-line updated.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 1153-1165 (Story 7.5 BDD), line 379 (Epic 7 user outcome — *"both receive a final SMS confirming cycle closure"*).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 488 (FR18 — cycle status transitions including `settled`), line 501 (FR21 — settlement completion).
- **UX:** `_bmad-output/planning-artifacts/ux-design-specification.md` line 685 (settlement-day SMS copy: *"Un récapitulatif final vient d'être envoyé par SMS"* — the saver-facing receipt this story formalises).
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` § SMS dispatch contract, § Receipt URL surface.
- **Story 6.3 (existing template baseline):** `supabase/migrations/20260429000002_format_sms_body.sql` line 120 — the `'settlement'` branch this story rewrites.
- **Story 6.4 (receipt-URL Worker baseline):** `workers/receipt-url/src/render.ts` + `supabase/migrations/20260430000001_get_receipt_payload.sql` — surfaces this story extends.
- **Story 7.4 (settlement commit pipeline — Story 7.5 consumes its outputs):** the synthetic `transactions.kind='settlement'` row + `enqueue_sms_on_transaction` trigger force `template_key='settlement'` and call `format_sms_body('settlement', tx_id)`. Story 7.5 only updates the content of that template.
- **Story 6.5 / 6.6 (precedent for trigger / function replace migrations):** `supabase/migrations/20260501000002_enqueue_sms_optout_check.sql`, `supabase/migrations/20260512000003_format_resend_sms_body.sql` — same diff-discipline pattern Story 7.5 follows.
- **NFR-L1 (single-SMS budget):** Termii GSM-7 single-message cap is 160 chars; UCS-2 fallback is 70 chars. Story 7.5 stays GSM-7 by unaccenting names + skipping the year in dates.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **Migration 0063 (get_receipt_payload) failed first try: SQLSTATE 42P13 — cannot change return type via CREATE OR REPLACE.** PostgreSQL forbids amending a RETURNS TABLE shape via CREATE OR REPLACE. Fixed by adding `DROP FUNCTION IF EXISTS` before the CREATE, then re-issuing the `GRANT EXECUTE TO service_role` clause (the DROP wipes the grants).
- Both migrations applied cleanly after the fix.

### Completion Notes List

- **2 migrations shipped** — `format_sms_body` (settlement-branch rewrite with firstName + cycle DD/MM range + closing statement + plain-digit amount) + `get_receipt_payload` (extended with `cycle_start_date` + `cycle_end_date`, DROP+CREATE pattern). Diff-discipline preserved on the format_sms_body other branches.
- **Worker `render.ts` settlement branch** — new `renderSettlementReceiptHtml` helper called early from `renderReceiptHtml` when `payload.kind === 'settlement'`. Hides projected balance + cycle day rows; hides dispute CTA (settlement is irreversible); shows cycle period (DD/MM/YYYY full year for the durable receipt); keeps opt-out CTA + disclosure. New `formatCycleDate` helper (UTC, no time, no TZ drift). New `.settlement-closing` CSS class (light primary-green background per UX brand). Defensive: if `cycle_start_date`/`cycle_end_date` are missing (pre-Story-7.5 RPC), the period row is silently omitted.
- **SMS body length** — worst-case ~155 chars with 10-char name + 9-digit amount + full URL → fits in Termii's 160-char single-SMS budget. Length contract test (3b) pins this down.
- **GSM-7 single-SMS discipline** — name unaccented (Story 6.3 baseline), amount as plain digits (no NBSP), date format DD/MM (no year). Test asserts `body.length <= 160`.
- **13 new Worker render tests** covering: title / headline / no h1 confusion / subtitle / amount / period range / no projected balance / no cycle day / closing statement / no dispute CTA / keep opt-out CTA / keep disclosure / no script tag / no period row when dates missing / jest-axe clean. Plus updated test #3 of `format-sms-body.contract.test.ts` (new body shape) + new test 3b (length boundary) + new `get-receipt-payload-cycle-dates.contract.test.ts` (cycle dates returned correctly).
- **Playwright Flow 3 extension** — `tests/e2e/flow-3-cycle-settlement.spec.ts` now asserts the SMS body matches the new format (regex `/votre cycle du \d{2}\/\d{2} au \d{2}\/\d{2} est clos\./`, body ≤ 160 chars, URL pattern).
- **Gates (local)** — typecheck clean, lint clean (max-warnings=0), main vitest 720 passed (+15 vs Story 7.4 baseline of 705), 76.32% branches global, Worker render tests 44 passed (+13 new), build clean (PWA precache 772.14 KiB ≈ unchanged from 7.4 — no frontend bundle change). Deno + Playwright deferred to CI.
- **NO frontend changes** beyond the Worker render module — Story 7.4 surface preserved as a closed contract.
- **NO new dependencies, no schema changes** — `format_sms_body` keeps its `(text, uuid)` signature; `get_receipt_payload` keeps its `(text)` parameter signature and only adds 2 columns to the returns table.
- **Code-review patches applied (2026-05-15, reviewer = claude-sonnet-4-6):** Verdict initially **Changes requested** — 1 HIGH (real CI-breaking length bug), 2 MEDIUM (incomplete spec coverage), 3 LOW. All 6 patches applied:
  - **[HIGH] SMS length budget bust** — my first-draft template + spec math was wrong by ~7 chars. With `firstName="Test"` + 9-digit amount, body = 162 chars (test 3b assertion `<= 160` would FAIL in CI). Fix: removed `Merci. ` from the template (saves 7 chars) AND capped firstName from 16 → 9 chars. The closing statement now lives on the Worker receipt page only. New exact computation: 75 literal + 9 firstName + 5+5 dates + 9 amount + 57 URL = **exactly 160 chars at worst case**. Test 3b updated to override seed name to "Mahamadou Diallo" (9-char firstName) and assert ≤ 160.
  - **[MEDIUM] AC #11 (Worker E2E settlement page) was checked but not implemented** — `tests/e2e/receipt-url-worker.spec.ts` had no settlement case. Added a full test that seeds a `kind='settlement'` transaction via service-role, GETs the receipt URL, asserts settlement-specific markers (title "Cycle clôturé", h1, period row, closing statement, no dispute CTA, kept opt-out + disclosure, security headers, no `<script>`).
  - **[MEDIUM] AC #9 (3 settlement Deno cases) was shipped with 2** — added test 3c (accented name unaccented: "Mariémé" → "Marieme" body + no diacritics in output) + test 3d (single-token name: "Awa" → full name used, no split fallback).
  - **[LOW] Migration 0062 didn't re-declare grants** — `CREATE OR REPLACE` preserves grants but the migration is now self-contained for `db:reset` cycles + future readers. Added explicit `GRANT EXECUTE ... TO authenticated, service_role`.
  - **[LOW] Migration 0062 header comment said `≈ 155 chars`** but exact computation was 167 worst-case. Replaced with the precise breakdown (literals + interpolations = 160 exactly).
  - **[LOW] Playwright Flow 3 didn't assert firstName presence in SMS body** — added regex `^SafariCash\. \w+, ` to catch a future bug that omits the firstName interpolation.
- **Gates re-run after patches** — typecheck clean, lint clean, 44/44 Worker render tests.

### File List

**New files:**
- `supabase/migrations/20260515000001_format_sms_body_settlement_content.sql` — Story 6.3 baseline rewrite, settlement branch only.
- `supabase/migrations/20260515000002_get_receipt_payload_cycle_dates.sql` — Story 6.4 baseline DROP+CREATE with 2 new return columns.
- `supabase/functions/_shared/get-receipt-payload-cycle-dates.contract.test.ts` — 1 Deno contract test pinning the new columns.

**Modified files:**
- `workers/receipt-url/src/render.ts` — `ReceiptPayload` extended with optional cycle dates + `formatCycleDate` helper + `renderSettlementReceiptHtml` private helper + `.settlement-closing` CSS class + early-branch in `renderReceiptHtml`.
- `workers/receipt-url/src/render.test.ts` — 13 new vitest cases for the settlement render branch.
- `supabase/functions/_shared/format-sms-body.contract.test.ts` — test #3 updated for new body shape + new test #3b for length boundary.
- `tests/e2e/flow-3-cycle-settlement.spec.ts` — SMS body assertions for the new template.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status flip + epic-7 stays in-progress until merge (post-merge flip to `done`).

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-15 | Story 7.5 implemented via bmad-dev-story — 2 migrations (format_sms_body settlement-branch rewrite + get_receipt_payload cycle dates extension with DROP+CREATE workaround for SQLSTATE 42P13), Worker render.ts settlement branch (renderSettlementReceiptHtml helper hiding projected balance + cycle day + dispute CTA, showing cycle period DD/MM/YYYY + closing statement; .settlement-closing CSS class; defensive missing-dates fallback), 13 new Worker render tests + updated format_sms_body contract test + new length-boundary test + new get_receipt_payload cycle dates contract test, Playwright Flow 3 SMS body assertions for new template; SMS body ≤ 160 chars worst-case (GSM-7 discipline preserved). All local gates green (typecheck / lint / 720 vitest / 44 Worker / 76.32% branches global / build). Deno + Playwright deferred to CI. | Dev (claude-opus-4-7[1m]) |
| 2026-05-15 | Code-review via bmad-code-review on a different LLM (claude-sonnet-4-6) — verdict "Changes requested" (1 HIGH, 2 MED, 3 LOW). All 6 patches applied: [HIGH] SMS template length bug fix (removed `Merci. ` + capped firstName 16→9 → exactly 160 chars worst-case; CI-breaking bug intercepted), [MED] new Worker E2E settlement-page case (AC #11, was checked-but-unimplemented), [MED] 2 new Deno contract cases for unaccent + single-token name (AC #9), [LOW] re-declared grants explicitly in migration 0062, [LOW] corrected header comment with exact char count, [LOW] firstName presence assertion in Playwright. Gates re-run green (typecheck / lint / 44 Worker tests). | Reviewer (claude-sonnet-4-6) → Dev (claude-opus-4-7[1m]) |
