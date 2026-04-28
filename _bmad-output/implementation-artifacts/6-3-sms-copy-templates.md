# Story 6.3: SMS copy templates (first, subsequent, settlement, dispute ack)

Status: ready-for-dev

## Story

As a **developer**,
I want **French copy templates for every SMS the system sends (first receipt with consent, subsequent receipts, settlement, dispute acknowledgement)**,
so that **saver-facing language is consistent and compliant with NFR-S10 (UX-DR14–17).**

> **Predicate of this story.** Story 6.1 shipped the `template_key` column + the `enqueue_sms_on_transaction` trigger that picks `'first_receipt'` vs `'subsequent_receipt'` based on prior-SMS history; the trigger currently writes a STUB literal `'[STUB] Transaction enregistrée'` to `sms_queue.body`. Story 6.2 shipped the worker that drains the queue and dispatches via Termii — the worker is template-agnostic, it just sends `body` as-is. Story 6.3 closes the loop: ships the real French copy via a `format_sms_body(p_template_key, p_transaction_id)` SQL helper (architecture decision: SQL not TS — the helper is called from the trigger, which fires AT INSERT time, before any Edge Function sees the row); replaces `enqueue_sms_on_transaction` to invoke the helper; and adds the `transactions.receipt_token` column the templates reference (Story 6.4 will resolve those tokens to receipt-page renders via the Cloudflare Worker — Story 6.3 does NOT ship the Worker). **What Story 6.3 does NOT ship**: the receipt-page Cloudflare Worker (Story 6.4); the `members.sms_opt_out` column (Story 6.5); the settlement-trigger that emits the `'settlement'` template body (Story 7.5 wires the cycle-close path that triggers settlement SMS); the dispute-ack trigger (Story 10.2 wires the receipt-URL `/dispute` POST that triggers dispute_ack SMS). All four templates are SHIPPED in this story; the latter two are NOT YET wired to a real SMS commit path — they're available for Stories 7.5 / 10.2 to call directly. WhatsApp delivery (Story 6.8) is also out of scope.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 991-1004; the rest are spec-derived constraints required for a flawless implementation.

1. **Schema — `transactions.receipt_token` column.** New migration `20260429000001_add_receipt_token_to_transactions.sql`:
   - `ALTER TABLE public.transactions ADD COLUMN receipt_token text NULL;` initially nullable for the backfill step.
   - **Token generation:** `encode(gen_random_bytes(16), 'hex')` — produces 32 hex chars = 128 bits of entropy (NFR-S3 *"≥ 128 bits"* compliance, **even though Story 6.4 is what enforces NFR-S3 at the Worker layer**; Story 6.3 ships the column so 6.4 has the data path ready).
   - **Backfill existing rows:** `UPDATE public.transactions SET receipt_token = encode(gen_random_bytes(16), 'hex') WHERE receipt_token IS NULL;` — pre-prod local dev only; CI starts clean so this UPDATE is a no-op there.
   - `ALTER TABLE public.transactions ALTER COLUMN receipt_token SET NOT NULL;` after backfill.
   - `ALTER TABLE public.transactions ADD CONSTRAINT transactions_receipt_token_chk CHECK (length(receipt_token) = 32 AND receipt_token ~ '^[0-9a-f]{32}$') NOT VALID;` — defends against future code paths inserting malformed tokens.
   - `ALTER TABLE public.transactions VALIDATE CONSTRAINT transactions_receipt_token_chk;` after backfill.
   - **Default for new rows:** `ALTER TABLE public.transactions ALTER COLUMN receipt_token SET DEFAULT encode(gen_random_bytes(16), 'hex');` so future INSERTs (RPCs from Stories 4.3 / 4.4 / 5.4 + the Story 4.5 undo path) get tokens automatically.
   - `CREATE UNIQUE INDEX idx_transactions_receipt_token ON public.transactions (receipt_token);` — Story 6.4's Worker will look up by token; uniqueness is necessary.
   - **No RLS change** — `transactions` already has the standard collector_id-bound RLS from migration 0001.

2. **Receipt URL base config.** Add `RECEIPT_URL_BASE` env var (e.g., `https://safaricash.app/r`). Story 6.3 does NOT introduce a new place to read env from inside SQL — instead, the URL is composed server-side at SMS render time via `current_setting('app.receipt_url_base', true)` (Postgres GUC). The migration sets a sensible default at the database level: `ALTER DATABASE postgres SET app.receipt_url_base = 'https://safaricash.app/r';` (overridable per-environment via `supabase secrets` / `.env.local` + `psql -c "ALTER DATABASE ... SET ..."`). The `format_sms_body` helper reads via `current_setting('app.receipt_url_base', true)`. **If the GUC isn't set, fall back to the literal `'https://safaricash.app/r'`** (defensive; mirrors how Story 6.1 handled `app.source`).

3. **Helper SQL function `format_sms_body(p_template_key text, p_transaction_id uuid) RETURNS text`.** Migration `20260429000002_format_sms_body.sql`:
   - SECURITY DEFINER, `search_path = public, pg_temp`.
   - Reads transaction details: amount, cycle_day, member_name (via `vault_decrypt(members.name_encrypted)`), member.daily_amount, sum of outstanding advances on this cycle.
   - Computes projected balance: `dailyAmount * 29 - sum(advances)` (mirrors `computeProjectedFinalBalance` in `src/domain/cycle/cycleEngine.ts:43-45` — the SAME formula in SQL).
   - Composes the receipt URL: `current_setting('app.receipt_url_base', true) || '/' || receipt_token` (with the GUC fallback per AC #2).
   - **Branches by `p_template_key`:**
     - `'first_receipt'` — full template (see AC #4 for verbatim copy).
     - `'subsequent_receipt'` — short template (see AC #5).
     - `'settlement'` — the body composition needs cycle-close totals (totalSettled), so `format_sms_body` for settlement takes a different code path: `p_transaction_id` is the **settlement transaction's ID**; the helper joins on `cycles` to get the settled total. See AC #6.
     - `'dispute_ack'` — `p_transaction_id` is the **disputed transaction's ID**; the helper joins on `disputes` to get the dispute reference. See AC #7.
   - **Returns:** the body string (UTF-8, but constrained to GSM-7-equivalent chars — see AC #9).
   - **Defensive: if `p_template_key` is invalid**, raise `'invalid_template_key'` with errcode `'22000'`.
   - **Defensive: if transaction not found**, raise `'transaction_not_found'` with errcode `'P0002'`.
   - GRANT EXECUTE TO authenticated + service_role.

4. **Template — `first_receipt`** (verbatim copy, French, ASCII-only, ≤ 320 chars / 2 SMS segments — UX-DR14):

   ```
   Bonjour {prenom}. Recu SafariCash: {amount} FCFA, jour {day}/30. Solde projete fin de cycle: {projected} FCFA. Detail: {url}. SafariCash est un journal d'epargne et non une banque. Repondez STOP pour ne plus recevoir.
   ```

   - **Placeholders:**
     - `{prenom}` — first token of `vault_decrypt(members.name_encrypted)` split on whitespace; truncated to 20 chars max. If name is missing/empty (impossible per Story 1.2 schema, but defensive), use `'Saver'`.
     - `{amount}` — formatted with `to_char(amount, 'FM999G999G999')` (thousands grouping with non-breaking spaces in Postgres locale; we'll force ASCII space via REPLACE → `' '`).
     - `{day}` — `transactions.cycle_day`.
     - `{projected}` — same `to_char` formatting.
     - `{url}` — composed per AC #2.
   - **Length budget:** worst case (longest name 20 + amount 13 + day 2 + projected 13 + url 47 ≈ 95 + fixed copy 235 = 330) — *just over 320*. **Mitigation:** truncate `prenom` to 16 chars (was 20), shorten fixed copy by 5 chars. Re-verify in unit test.
   - **Tracker-not-mover disclosure (NFR-S10):** *"SafariCash est un journal d'epargne et non une banque."* — verbatim, ASCII-clean.
   - **Opt-out instruction (FR31):** *"Repondez STOP pour ne plus recevoir."* — Story 6.5 will wire the actual `STOP` keyword reception via Termii's webhook (out of scope here); the template ships the user-visible instruction.

5. **Template — `subsequent_receipt`** (verbatim, ASCII-only, ≤ 160 chars / 1 SMS segment — UX-DR15):

   ```
   SafariCash. {amount} FCFA recu, jour {day}/30. Solde projete: {projected} FCFA. Detail: {url}.
   ```

   - **Placeholders:** same as first_receipt minus `{prenom}`.
   - **Length budget:** worst case (amount 13 + day 2 + projected 13 + url 47 = 75 + fixed copy 78 = 153). Within 160.
   - **No greeting, no consent disclosure, no opt-out instruction** — the M-Pesa-style rigid format (UX-DR15 + UX spec line 251). Predictability over politeness.

6. **Template — `settlement`** (verbatim, ASCII-only, ≤ 160 chars — UX-DR16):

   ```
   SafariCash. Cycle clos. Vous avez recu {totalSettled} FCFA. Merci. Detail: {url}.
   ```

   - **Placeholders:**
     - `{totalSettled}` — the settlement transaction's amount (will be `cycles.daily_amount * 29 - sum(outstanding_advances)` per the cycle-engine `settle()` function).
     - `{url}` — Story 6.4 will eventually serve the cycle-summary page at this URL; for Story 6.3 it's the same scheme as receipt URLs but for the settlement transaction.
   - **Length budget:** 67 + 13 = 80 chars + url 47 = 127. Well within 160.
   - **NOT yet triggered** — Story 7.5 wires the cycle-close path that creates a settlement transaction; until then, this template exists but isn't called by any production code.

7. **Template — `dispute_ack`** (verbatim, ASCII-only, ≤ 160 chars — UX-DR17):

   ```
   SafariCash. Votre signalement a ete recu. Reponse sous 48h. Reference: {disputeRef}.
   ```

   - **Placeholders:**
     - `{disputeRef}` — short-form reference (e.g., first 8 chars of `disputes.id`).
   - **Length budget:** ~85 + 8 = 93 chars. Well within 160.
   - **No accusation language** (UX-DR17): copy is compassionate, action-oriented, NOT *"Nous enquêtons sur la fraude"* or similar.
   - **NOT yet triggered** — Story 10.2 wires the receipt-URL `/dispute` POST that creates a `disputes` row + dispatches the SMS; until then, the template exists but isn't called.

8. **Banned banking language (NFR-S10).** The four templates MUST NOT contain (case-insensitive): `compte`, `depot`, `dépôt`, `garanti`, `bancaire`, `banque` (except in the *"non une banque"* tracker-not-mover disclosure phrase — that's the ONE allowed use of `banque`). Verified by the linter test (AC #14).

9. **GSM-7 / 7-bit ASCII compliance (NFR-A6).** All four template bodies after substitution MUST contain ONLY characters in the GSM-7 base alphabet (i.e., 7-bit ASCII printables 0x20-0x7E plus a small set of accented chars like `é`, `è`, `à`, `ù` that are part of the GSM-7 default-alphabet extension — but NOT emoji, NOT typographic quotes `'`, NOT em dashes `—`).
   - **Conservative approach taken in this story**: stick to **pure 7-bit ASCII** (drop accented characters from the template literals). The placeholder copy uses unaccented spellings (`Recu`, `enregistre`, `epargne`, `Repondez`, `Reponse`, `Reference`) — Senegalese French speakers parse this fluently.
   - The `{prenom}` placeholder is decrypted from member.name (vault) — that may CONTAIN accented chars. **Solution:** the helper applies `unaccent()` (the Postgres extension is already available; verify via `CREATE EXTENSION IF NOT EXISTS unaccent;` in the migration). The unaccented string is what lands in the SMS.
   - **Verified by:** AC #16 unit test (regex `^[\x20-\x7E]+$` on the rendered body).

10. **Trigger replacement migration `20260429000003_enqueue_sms_format_body.sql`.** Replaces `enqueue_sms_on_transaction` (Story 4.3 → 6.1 lineage) so the trigger:
    - Picks `template_key` per Story 6.1's existing logic (no change there).
    - **Calls `format_sms_body(v_template_key, NEW.id)` to compose the body** (replacing the STUB literal).
    - INSERTs the row with the rendered body.
    - **Trigger ordering UNCHANGED** (still the AFTER INSERT order from Stories 4.3 / 4.4 / 5.4 / 6.1).
    - Same SECURITY DEFINER, same search_path, same UNCHANGED ALL OTHER LINES — diff vs migration 0035 should be ~3 lines (the body line) + 1 comment line. Mirror the byte-for-byte discipline of Story 6.2's audit-allowlist extension.

11. **Receipt-URL handshake with Story 6.4.** The `receipt_token` column lands in this story; Story 6.4 builds the Cloudflare Worker that resolves `/r/{token}` → receipt page render. The Worker reads `transactions` via service-role Supabase client filtered by `receipt_token = $1` (single SELECT; the unique index serves it in O(1)). Document this hand-off in the migration's comment AND in Dev Notes.

12. **No new dependencies.** Postgres `unaccent` extension comes pre-installed with Supabase; the `CREATE EXTENSION IF NOT EXISTS unaccent;` line is idempotent. No npm / jsr deps; no Edge Function changes (the worker from Story 6.2 reads `body` as-is).

13. **No new i18n keys.** Saver-facing SMS is fr-only at MVP. (Collector-app i18n keys for Story 6.6's "Renvoyer le reçu" UI land in 6.6, not here.)

14. **Tests — banking-language linter (Deno).** New `supabase/functions/_shared/sms-templates-banking-language.contract.test.ts`:
    - For each template_key in `['first_receipt', 'subsequent_receipt', 'settlement', 'dispute_ack']`, call `format_sms_body(...)` against a seeded fixture transaction and verify the rendered body contains NONE of the banned words (case-insensitive). The `'banque'` test asserts it appears EXACTLY once across `first_receipt` (the tracker-not-mover phrase) and ZERO times in the other three.
    - Uses the shared `seedCollector` + `seedMemberWithCycle` helpers from `_shared/test-fixtures.ts` (Story 6.2 extracted them).

15. **Tests — `format_sms_body` SQL contract (Deno).** New `supabase/functions/_shared/format-sms-body.contract.test.ts`:
    - **Case 1** — `format_sms_body('first_receipt', <txId>)` for a member named `Fatou Diallo` with amount 500, day 1, no advances → exact-match body assertion.
    - **Case 2** — `format_sms_body('subsequent_receipt', <txId>)` → exact-match.
    - **Case 3** — `format_sms_body('settlement', <txId>)` for a settlement-kind transaction (insert directly via service role; cycles.daily_amount=500, no advances → totalSettled = 500*29 = 14_500). Exact-match.
    - **Case 4** — `format_sms_body('dispute_ack', <txId>)` against a transaction with a dispute row (insert directly via service role). Exact-match (the disputeRef is the first 8 chars of dispute.id; assert via prefix match).
    - **Case 5** — Invalid template_key (`'invalid'`) raises `22000`.
    - **Case 6** — Non-existent `p_transaction_id` raises `P0002`.
    - **Case 7** — Member name with accents (`José`) → unaccented (`Jose`) in the body.
    - **Case 8** — `app.receipt_url_base` GUC override → URL prefix changes accordingly. Set `SET LOCAL app.receipt_url_base = 'http://localhost:8787/r'` then call helper → URL is `http://localhost:8787/r/<token>`.

16. **Tests — length budgets (Deno).** New `supabase/functions/_shared/sms-templates-length.contract.test.ts`:
    - Render each of the 4 templates with **worst-case input** (member name = 20 chars, amount = 9_999_999, day = 30, projected = 14_500, advances = none).
    - Assert: `first_receipt.length <= 320` (2 segments).
    - Assert: `subsequent_receipt.length <= 160` (1 segment).
    - Assert: `settlement.length <= 160`.
    - Assert: `dispute_ack.length <= 160`.

17. **Tests — GSM-7 / ASCII compliance (Deno).** Same `sms-templates-length.contract.test.ts` adds:
    - For each rendered body, regex match `^[\x20-\x7E]+$` (printable 7-bit ASCII range).

18. **Tests — Story 6.1 trigger contract regression.** The existing `_shared/sms-dispatch-trigger.contract.test.ts` asserts `template_key='first_receipt'` / `subsequent_receipt`. After Story 6.3's migration replaces the trigger function, the test MUST still pass — same template_key choice, just a different body. Update the test to also assert: **the body is no longer the STUB literal `'[STUB] Transaction enregistrée'`** (replace with `assertStringIncludes(body, 'SafariCash')` — the brand name appears in every template).

19. **Wire test paths into `scripts/run-edge-tests.sh`.** Add the 3 new contract test files.

20. **All gates green.**
    - `npm run db:migrate` — applies 3 new migrations.
    - `npm run db:types` — regenerates `database.types.ts` so the new `receipt_token` column lands in the typed surface.
    - `npm run typecheck` / `npm run lint` / `npm run test` (vitest sanity — no new client code) / `npm run test:edge` (Deno; runs the 3 new contract test suites + regression of Story 6.1's trigger test) / `npm run build` — all green.
    - Spot-check via psql: `select format_sms_body('first_receipt', '<existing-tx-id>');` returns a recognisable body.

## Tasks / Subtasks

- [ ] **Task 1 — Migration 0040: `receipt_token` column** (AC #1)
  - [ ] Save as `supabase/migrations/20260429000001_add_receipt_token_to_transactions.sql`.
  - [ ] Idempotent ADD COLUMN + backfill + SET NOT NULL + CHECK (NOT VALID then VALIDATE) + DEFAULT + UNIQUE INDEX.
  - [ ] Apply via `npm run db:migrate`.
  - [ ] `npm run db:types` to refresh `database.types.ts`.

- [ ] **Task 2 — Migration 0041: `format_sms_body` helper** (AC #2, #3, #4, #5, #6, #7, #9, #11)
  - [ ] Save as `supabase/migrations/20260429000002_format_sms_body.sql`.
  - [ ] `CREATE EXTENSION IF NOT EXISTS unaccent;` (idempotent).
  - [ ] `ALTER DATABASE postgres SET app.receipt_url_base = 'https://safaricash.app/r';` (overridable per env).
  - [ ] Define `format_sms_body(p_template_key text, p_transaction_id uuid) RETURNS text` SECURITY DEFINER.
  - [ ] Branch on template_key; helper internal `format_amount(numeric)` PL/pgSQL inline that does `to_char + REPLACE` to ASCII-safe groupings.
  - [ ] Apply migration; spot-check via psql.

- [ ] **Task 3 — Migration 0042: trigger replacement** (AC #10)
  - [ ] Save as `supabase/migrations/20260429000003_enqueue_sms_format_body.sql`.
  - [ ] Re-derive function body from migration 0035 (Story 6.1's `enqueue_sms_on_transaction`); change ONLY the body line `'[STUB] Transaction enregistrée'` → `format_sms_body(v_template_key, new.id)`.
  - [ ] Diff vs migration 0035 should be ~3 lines.
  - [ ] Apply migration.

- [ ] **Task 4 — `format_sms_body` contract tests** (AC #15)
  - [ ] `supabase/functions/_shared/format-sms-body.contract.test.ts` — 8 cases per AC #15.
  - [ ] Use shared `seedCollector` / `seedMemberWithCycle` from `_shared/test-fixtures.ts`.

- [ ] **Task 5 — Banking-language linter test** (AC #14)
  - [ ] `supabase/functions/_shared/sms-templates-banking-language.contract.test.ts` — 4 templates × banned-words assertion.

- [ ] **Task 6 — Length-budget + GSM-7 compliance tests** (AC #16, #17)
  - [ ] `supabase/functions/_shared/sms-templates-length.contract.test.ts` — 4 length asserts + 4 ASCII-regex asserts.

- [ ] **Task 7 — Update Story 6.1 trigger test** (AC #18)
  - [ ] Edit `supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts` to replace the STUB-body assertion (if present) with `assertStringIncludes(body, 'SafariCash')`.

- [ ] **Task 8 — Wire test paths** (AC #19)
  - [ ] Add 3 new test paths to `scripts/run-edge-tests.sh`.

- [ ] **Task 9 — Verify all gates green** (AC #20)
  - [ ] `npm run typecheck` / `lint` / `test` / `test:edge` / `build` all green.
  - [ ] `npm run db:types` re-run; `database.types.ts` includes `receipt_token`.

## Dev Notes

### Architecture intelligence

- **architecture.md:1141 (data flow #6):** *"sms-worker Edge Function (scheduled) drains sms_queue, calls Termii, updates status."* — The worker doesn't render templates; it sends `body` as-is. Story 6.3 ships the body content.
- **prd.md:601 (NFR-A6):** *"SMS receipt — plain 7-bit ASCII where possible (broadest feature-phone compatibility); fall back to GSM-7 encoding; avoid emoji in receipt body."*
- **prd.md:582 (NFR-S10):** *"Saver-facing comms (SMS body, receipt URL page) contain no banking language … and carry the prescribed tracker-not-mover disclosure."*
- **prd.md:575 (NFR-S3):** *"Receipt URL token entropy — ≥ 128 bits, unguessable, non-sequential."*
- **ux-design-specification.md:251 (UX-DR15):** *"Monzo-style warmth without over-warmth. First SMS: short greeting, transaction summary, receipt URL. Subsequent SMS: no greeting, just data. Humanity on first touch, efficiency on repetition."*
- **epics.md:219-222 (UX-DR14–17):** definitions of the four template variants.

### Story 6.1 / 6.2 handshake — what's already in place

- `template_key` enum is the single source of truth. Story 6.1's trigger picks `'first_receipt'` for the saver's first SMS and `'subsequent_receipt'` thereafter; Story 7.5 will pick `'settlement'` at cycle close; Story 10.2 will pick `'dispute_ack'` at dispute creation.
- `audit_append_external` already supports the `sms.queued` / `sms.sent` / `sms.failed` / `sms.abandoned` event types (Story 6.2). No audit-chain changes in Story 6.3.
- The worker (Story 6.2) is template-agnostic — it sends whatever body the row holds. Replacing the STUB body with the real template causes ZERO worker changes.

### Story 6.4 handshake — receipt URL Worker

- Story 6.3 ships `transactions.receipt_token` (32 hex chars, 128-bit entropy, unique index). Story 6.4 ships the Cloudflare Worker at `workers/receipt-url/` that handles GET `/r/{token}`:
  - Look up `transactions` row by `receipt_token = $1` via service-role Supabase.
  - Render a server-side HTML page (no JS — UX-DR19) with amount, date, cycle day, projected balance, dispute CTA.
  - Story 6.4 ALSO ships the URL base — replace the GUC default `'https://safaricash.app/r'` with the actual production domain at deploy time.

### Story 6.5 handshake — opt-out

- Story 6.5 ships `members.sms_opt_out` + the Termii webhook receiver for `STOP` keyword. The first_receipt template ships the user-visible instruction *"Repondez STOP pour ne plus recevoir."* — that copy survives untouched into Story 6.5; only the action handler lands later.

### Story 7.5 handshake — settlement SMS

- Story 7.5's settlement-commit path will call `format_sms_body('settlement', <settlement_tx_id>)` directly (or insert a settlement-kind transaction row, which fires the existing trigger that picks `template_key='settlement'` based on transactions.kind — though the current trigger logic checks kind only for skipping `(contribution|rattrapage|advance)`). **Decision left to Story 7.5:** either extend the trigger to dispatch settlement-kind SMS, OR call the helper + insert directly. Story 6.3 just ships the template body.

### Story 10.2 handshake — dispute_ack SMS

- Story 10.2 wires the dispute receipt-URL POST. When a dispute lands, it inserts a `disputes` row + calls `format_sms_body('dispute_ack', <disputed_tx_id>)` to compose the body, then enqueues to `sms_queue` directly (the existing trigger doesn't fire on disputes-table inserts; that's a separate path). Story 6.3 just ships the template + the JOIN to disputes.

### Performance + correctness caveats

- `format_sms_body` runs INSIDE the trigger that fires on every transaction commit. SLO: stay under ~10ms per call. The helper does ~3 small SELECTs (transaction, member, advances sum) — well within budget.
- `unaccent()` allocates per-call; if perf becomes a concern, the alternative is a pre-baked translation map in PL/pgSQL. Acceptable for MVP.
- The `app.receipt_url_base` GUC is read once per call via `current_setting('app.receipt_url_base', true)`. With the `true` flag, missing GUC returns NULL (not an error) — the helper falls back to the literal default.

### Project structure notes

- Source tree:
  - NEW: `supabase/migrations/20260429000001_add_receipt_token_to_transactions.sql`
  - NEW: `supabase/migrations/20260429000002_format_sms_body.sql`
  - NEW: `supabase/migrations/20260429000003_enqueue_sms_format_body.sql`
  - NEW: `supabase/functions/_shared/format-sms-body.contract.test.ts`
  - NEW: `supabase/functions/_shared/sms-templates-banking-language.contract.test.ts`
  - NEW: `supabase/functions/_shared/sms-templates-length.contract.test.ts`
  - MODIFIED: `supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts` (1-line assertion update)
  - MODIFIED: `scripts/run-edge-tests.sh` (3 new test paths)
  - MODIFIED: `src/infrastructure/supabase/database.types.ts` (re-generated; `receipt_token` lands)
  - MODIFIED: `_bmad-output/implementation-artifacts/sprint-status.yaml`
- All paths align with architecture.md § Source Tree.
- No conflicts with prior stories.

### Testing standards

- Edge Function tests use Deno + `jsr:@std/assert@1` (already-established pattern).
- Reuse `_shared/test-fixtures.ts` for collector/member seeding.
- All four templates exercised directly via `service.rpc('format_sms_body', { p_template_key, p_transaction_id })`.
- Coverage gate: 100% on the SQL helper (4 success branches + 2 error branches + 1 GUC override + 1 unaccent path = 8 cases).
- Existing 6.1 trigger test gets a 1-line update (assertion of `'SafariCash'` substring).

### References

- [Source: epics.md#Story 6.3] — BDD acceptance criteria.
- [Source: epics.md#UX-DR14-17] — template-variant definitions.
- [Source: ux-design-specification.md:251] — UX-DR15 first/subsequent SMS warmth gradient.
- [Source: prd.md#NFR-S3 (line 575)] — receipt URL token entropy ≥ 128 bits.
- [Source: prd.md#NFR-S10 (line 582)] — banned banking language + tracker-not-mover disclosure.
- [Source: prd.md#NFR-A6 (line 601)] — 7-bit ASCII / GSM-7 SMS body constraint.
- [Source: src/domain/cycle/cycleEngine.ts:43-45] — `computeProjectedFinalBalance` formula mirrored in SQL.
- [Source: supabase/migrations/20260427000004_enqueue_sms_template_key.sql] — the trigger this story replaces.
- [Source: supabase/functions/_shared/test-fixtures.ts] — shared test seeders.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

### Completion Notes List

Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
