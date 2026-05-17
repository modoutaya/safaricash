# Story 10.5: Saver opt-out action surface from receipt URL

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **saver**,
I want **to opt out of future SMS from the receipt URL page and receive one final confirmation that my choice was honoured**,
so that **I can respectfully stop notifications without replying "STOP" to an SMS, and trust the opt-out landed (FR32 action surface).**

> **FIFTH and FINAL story of Epic 10 (Saver Dispute Flow & Data Rights) — closing the epic.** Story 6.5 already shipped the receipt-URL opt-out *plumbing*: the `GET`/`POST /r/{token}/opt-out` routes, the `set_member_sms_opt_out` RPC, the footer link, the form + confirmed pages. Story 10.5 completes the saver experience with the **two pieces 6.5 deliberately left for this story**:
> 1. **The final confirmation SMS.** When a saver opts out via the receipt URL, exactly one SMS is sent acknowledging the opt-out and explaining that re-subscription goes through their collector. This is the only part of the AC that does not yet exist.
> 2. **The `anonymised_at` gate.** Story 10.4 just shipped `members.anonymised_at`. An anonymised saver's data is already destroyed — the opt-out link must not show on their receipt page, and the opt-out routes must not serve them. AC #1 is explicit: the link shows only "for a **non-anonymised** member".
>
> **What 10.5 ships:**
> 1. **One migration** — adds an `opt_out_confirmation` SMS template to `format_sms_body` + the `sms_queue.template_key` CHECK; extends `set_member_sms_opt_out` to enqueue the confirmation SMS when (and only when) the opt-out is via the receipt URL; extends `get_receipt_payload` + `get_member_id_from_token` to return `anonymised_at`.
> 2. **The receipt-URL Worker** (`workers/receipt-url/`) — hides the footer opt-out link for an anonymised member; 404s the opt-out routes for an anonymised member; updates the opt-out-confirmed copy to mention the SMS.
> 3. **The `sms-worker`** — one type-union line so an `opt_out_confirmation` queue row type-checks.
>
> **The confirmation SMS, precisely:**
> - **Sent exactly once.** `set_member_sms_opt_out` is already idempotent — it early-returns on a repeat call (member already opted out). Putting the enqueue *after* that early-return means a repeated `POST /opt-out` (a saver refreshing) never sends a second SMS. The "once" guarantee is free.
> - **Scoped to the receipt-URL surface.** The enqueue fires only when `p_via = 'receipt_url'`. A STOP-keyword opt-out (`sms-inbound`) or a collector action does NOT trigger a confirmation SMS — the AC is about the receipt-URL action surface only.
> - **Bypasses the opt-out gate by construction.** It is a direct `INSERT INTO sms_queue` (not via the `enqueue_sms_on_transaction` trigger, which short-circuits on `sms_opt_out`), enqueued *after* the flag flips. `transaction_id` is `NULL` (the opt-out is member-scoped, not transaction-scoped) — exactly the `enqueue_dispute_ack` precedent.
>
> **Code-reuse map (DO NOT re-invent):**
> - **The opt-out plumbing already exists** — `workers/receipt-url/src/index.ts` has the `GET`/`POST /r/{token}/opt-out` routes; `set_member_sms_opt_out` (`supabase/migrations/20260501000004`) flips the flag, cancels queued SMS, emits `sms.opt_out`; `render.ts` has `renderOptOutFormHtml` / `renderOptOutConfirmedHtml` + the footer link. DO NOT rebuild these — extend them.
> - **The confirmation-SMS enqueue pattern** — `enqueue_dispute_ack` (`supabase/migrations/20260516203656_dispute-notify-trigger-and-enqueue.sql`): resolves `collector_id` + the vault-decrypted phone, `INSERT`s an `sms_queue` row with `format_sms_body(...)` as the body, `transaction_id` nullable, deliberately ungated on `sms_opt_out`. Mirror it (inline in `set_member_sms_opt_out`).
> - **`format_sms_body`** — `supabase/migrations/20260516203656` is the **current** definition (it added `dispute_ack`). `CREATE OR REPLACE` MUST rebase on that body and preserve `first_receipt` / `subsequent_receipt` / `settlement` / `dispute_ack`.
> - **The `template_key` CHECK** — find the latest migration that defines the `sms_queue.template_key` CHECK (`grep` — likely `20260516203656`) and drop+re-add it preserving every existing value.
> - **The `anonymised_at` source** — `members.anonymised_at` (Story 10.4, migration `20260516225824`); the `members_decrypted` view already exposes it. The Worker's two RPCs (`get_receipt_payload`, `get_member_id_from_token`) must be extended to return it.
> - **The Vault decrypt** — `vault_decrypt` (`supabase/migrations/20260419000005`); `set_member_sms_opt_out` is SECURITY DEFINER so it can call it (the `enqueue_dispute_ack` precedent).
>
> **What Story 10.5 does NOT ship:**
> - A re-opt-in / re-subscribe mechanism (the confirmation SMS only *explains* that re-subscription goes through the collector — building it is out of scope; consistent with Story 6.5's deferral).
> - Any fix to the `sms-worker`'s `optedOut = false` placeholder (a Story 6.5 carry-over). The opt-out is enforced at **enqueue time** (`enqueue_sms_on_transaction` already gates on `sms_opt_out`), which fully satisfies "no further transactional SMS". Fixing the worker-side placeholder would also require exempting `opt_out_confirmation` from it — a separate concern, explicitly out of scope.
> - Any change to the dispute pipeline (10.1–10.3) or `anonymise_member` (10.4).
> - A new npm dependency.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** trace to the `epics.md:1396-1405` BDD; the rest are spec-derived constraints.

### The migration — SMS template + RPC extensions

1. **`format_sms_body` gains `opt_out_confirmation`.** A new migration `supabase/migrations/<timestamp>_optout-confirmation-and-anonymised-gate.sql` (create via `npm run db:migrate:new optout-confirmation-and-anonymised-gate`) `CREATE OR REPLACE`s `public.format_sms_body` **starting from its current body** (`20260516203656_dispute-notify-trigger-and-enqueue.sql` — verify by `grep`), preserving every existing template (`first_receipt`, `subsequent_receipt`, `settlement`, `dispute_ack`). A new `opt_out_confirmation` branch returns a **static** body (no transaction lookup — it ignores `p_transaction_id`); place that branch first so it returns before any `transactions` SELECT.

2. **`sms_queue.template_key` CHECK extended.** The migration drops and re-adds the `sms_queue.template_key` CHECK constraint (find the latest migration defining it via `grep` — likely `20260516203656`; verify the constraint name) so `'opt_out_confirmation'` is an allowed value alongside every existing one.

3. **`set_member_sms_opt_out` enqueues the confirmation SMS.** The migration `CREATE OR REPLACE`s `public.set_member_sms_opt_out` **rebased on its current body** (`20260501000004`), preserving everything (the `p_via` validation, the not-found raise, the idempotent early-return, the `members` UPDATE, the queued-SMS cancellation, the `sms.opt_out` audit emit). It adds — **after the idempotent early-return and the `members` UPDATE**, and **only when `p_via = 'receipt_url'`** — a direct `INSERT INTO sms_queue` of an `opt_out_confirmation` row: `collector_id` = the member's collector, `transaction_id = NULL`, `recipient_phone` = `vault_decrypt(phone_number_encrypted)`, `body = format_sms_body('opt_out_confirmation', NULL)`, `status = 'queued'`, `template_key = 'opt_out_confirmation'`, `retry_count = 0`. (Mirror `enqueue_dispute_ack`'s INSERT shape.)

4. **`get_receipt_payload` returns `anonymised_at`.** The migration re-derives `public.get_receipt_payload` (DROP + CREATE — adding a column to a `RETURNS TABLE` is a signature change) from its current definition (`20260515000002`), adding `m.anonymised_at` to the `RETURNS TABLE` list and the SELECT (JOIN `members m`). Re-grant `EXECUTE` to the role(s) the current definition grants it to.

5. **`get_member_id_from_token` returns `anonymised_at`.** The migration re-derives `public.get_member_id_from_token` (DROP + CREATE — the return type changes from a scalar `uuid` to `RETURNS TABLE(member_id uuid, anonymised_at timestamptz)`) from `20260501000005`, preserving the token-resolution logic (`transactions.receipt_token`, `undone_at IS NULL`). Re-grant `EXECUTE`.

### The confirmation SMS

6. **Body.** The `opt_out_confirmation` body is static French copy: it acknowledges the SMS opt-out and states that re-subscription is done via the collector. It fits in **one SMS segment** (≤160 GSM-7 chars; match the accent/segment conventions of the existing `format_sms_body` templates) and is banking-language-clean (passes `sms-templates-banking-language.contract.test.ts`).

7. **Sent exactly once.** **And** a final confirmation SMS is sent **once** — the enqueue sits after `set_member_sms_opt_out`'s idempotent early-return, so a repeated `POST /r/{token}/opt-out` (already opted out) is a no-op and enqueues nothing further.

8. **Enqueued post-flip, ungated.** The confirmation row is a direct `INSERT` (not via the `enqueue_sms_on_transaction` trigger), issued after `sms_opt_out = true` is set — it is **not** suppressed by the opt-out gate. `transaction_id` is `NULL`.

9. **No-phone → no SMS.** **Given** a saver with no phone number (`phone_number_encrypted` decrypts to NULL/empty), the opt-out still succeeds (flag set, audit emitted) but **no** confirmation row is enqueued — a graceful skip, no error.

10. **Receipt-URL surface only.** A STOP-keyword opt-out (`sms-inbound`, `p_via = 'stop_keyword'`) and a collector action (`p_via = 'collector_action'`) do **NOT** enqueue a confirmation SMS. Only `p_via = 'receipt_url'` does.

### The `anonymised_at` gate

11. **The receipt-page footer link is gated.** **Given** a receipt URL page rendered for a **non-anonymised** member, **When** the saver scrolls to the footer, **Then** the "Ne plus recevoir de SMS" link is visible — exactly as today. For an **anonymised** member (`anonymised_at IS NOT NULL`) the entire `<section class="opt-out">` block is omitted from both `renderReceiptHtml` and `renderSettlementReceiptHtml`.

12. **`GET /r/{token}/opt-out` is gated.** For an anonymised member the opt-out form route returns **404** (the existing 404 HTML) rather than rendering the form.

13. **`POST /r/{token}/opt-out` is gated.** For an anonymised member the opt-out POST returns **404** and makes no change. (An anonymised member is already `sms_opt_out = true` from Story 10.4, so this is defence-in-depth — but a "stop SMS" page for a saver whose data is already deleted is incoherent and must not be served.)

### Existing behaviour preserved + the confirmed page

14. **The opt-out flow itself is unchanged for a non-anonymised member.** `POST /r/{token}/opt-out` still resolves the member, calls `set_member_sms_opt_out(member_id, 'receipt_url')` (sets `sms_opt_out`, stamps `sms_opt_out_at`/`sms_opt_out_via`, cancels queued SMS, emits `sms.opt_out`), and renders the confirmed page. No regression to the Story 6.5 routes/RPC behaviour.

15. **The confirmed page mentions the SMS.** `renderOptOutConfirmedHtml` copy is updated to tell the saver a confirmation SMS has been sent (and remains traceable/reversible via the collector).

### The Worker + the sms-worker

16. **Worker token resolution adapts.** The `ReceiptPayload` type (`render.ts`) gains `anonymised_at: string | null`. `fetchReceiptPayload` / `fetchMemberIdFromToken` (`index.ts`) adapt to the new RPC return shapes (`get_member_id_from_token` now returns a row `{ member_id, anonymised_at }`, not a bare `uuid`). The receipt-page handler and both opt-out handlers branch on `anonymised_at`.

17. **`sms-worker` type union.** `supabase/functions/sms-worker/index.ts` — the `ClaimedRow` (or equivalent) `template_key` union gains `"opt_out_confirmation"` so an `opt_out_confirmation` queue row type-checks. No behavioural change to the worker (the `optedOut` placeholder stays `false` — out of scope per the story header).

### Tests + gates

18. **Worker unit tests** (`workers/receipt-url/src/render.test.ts`): a receipt payload with `anonymised_at` set renders NO opt-out link (receipt + settlement pages); a non-anonymised payload still renders it; `renderOptOutConfirmedHtml` mentions the confirmation SMS.

19. **Playwright E2E** (`tests/e2e/receipt-url-worker.spec.ts`): after `POST /r/{token}/opt-out` for a non-anonymised member, an `sms_queue` row with `template_key = 'opt_out_confirmation'` (status `queued`, the member's phone) has landed; for an anonymised member, `GET /r/{token}` shows no opt-out link AND `GET /r/{token}/opt-out` returns 404.

20. **Contract tests** (`supabase/functions/_shared/`): `format_sms_body('opt_out_confirmation', NULL)` renders the expected body and passes the existing SMS length + banking-language contract suites; the `set_member_sms_opt_out` `receipt_url` path enqueues exactly one `opt_out_confirmation` row, and the `stop_keyword` path enqueues none.

21. **Migration smoke-tested; no new dependency; all gates green.** The migration is applied with `npm run db:migrate` (NEVER `db:reset`) and `psql`-smoke-tested (the confirmation enqueue on a `receipt_url` opt-out; none on `stop_keyword`; `get_receipt_payload` / `get_member_id_from_token` return `anonymised_at`; the `format_sms_body` rebase still renders all 4 prior templates). No `package.json` change. All gates green on Node 22 (`nvm use 22`): `typecheck`, `lint`, `test` (vitest — includes the Worker unit tests), `build`, `test:edge` (the pre-existing local `sms-inbound`/`sms-worker` Termii-secret failures are unrelated and expected), and the `receipt-url-worker` Playwright spec.

## Tasks / Subtasks

- [x] **Task 1 — Migration: the `opt_out_confirmation` SMS template** (AC: #1, #2, #6)
  - [x] `npm run db:migrate:new optout-confirmation-and-anonymised-gate`.
  - [x] `grep` for the latest `format_sms_body` definition (`20260516203656`); `CREATE OR REPLACE` it from that body + a leading `opt_out_confirmation` static-body branch; preserve all 4 existing templates.
  - [x] Drop + re-add the `sms_queue.template_key` CHECK with `'opt_out_confirmation'` added (verify the constraint name + the latest migration that defines it).
- [x] **Task 2 — Migration: `set_member_sms_opt_out` enqueues the confirmation** (AC: #3, #7, #8, #9, #10)
  - [x] `CREATE OR REPLACE set_member_sms_opt_out` rebased on `20260501000004` — preserve everything; after the idempotent early-return + the `members` UPDATE, when `p_via = 'receipt_url'`, resolve the decrypted phone (`vault_decrypt`) and, if non-empty, `INSERT` the `opt_out_confirmation` `sms_queue` row (mirror `enqueue_dispute_ack`'s shape; `transaction_id = NULL`).
- [x] **Task 3 — Migration: the `anonymised_at` gate RPCs** (AC: #4, #5)
  - [x] DROP + CREATE `get_receipt_payload` from `20260515000002` + `m.anonymised_at`; re-grant EXECUTE.
  - [x] DROP + CREATE `get_member_id_from_token` from `20260501000005` → `RETURNS TABLE(member_id uuid, anonymised_at timestamptz)`; re-grant EXECUTE.
- [x] **Task 4 — Apply + smoke-test the migration** (AC: #21)
  - [x] `nvm use 22 && npm run db:migrate`; `psql`-smoke-test per AC #21 (the `receipt_url` vs `stop_keyword` enqueue difference; both RPCs return `anonymised_at`; `format_sms_body` still renders the 4 prior templates).
- [x] **Task 5 — The receipt-URL Worker** (AC: #11, #12, #13, #15, #16)
  - [x] `render.ts`: `ReceiptPayload` + `anonymised_at`; `renderReceiptHtml` + `renderSettlementReceiptHtml` omit the `<section class="opt-out">` block when `anonymised_at` is set; update `renderOptOutConfirmedHtml` copy.
  - [x] `index.ts`: adapt `fetchMemberIdFromToken` to the new `get_member_id_from_token` row shape; the `GET` + `POST /opt-out` handlers return 404 when the member is anonymised; pass `anonymised_at` into the receipt render.
- [x] **Task 6 — `sms-worker` type union** (AC: #17)
  - [x] Add `"opt_out_confirmation"` to the `sms-worker` `ClaimedRow` `template_key` union.
- [x] **Task 7 — Tests + gates** (AC: #18, #19, #20, #21)
  - [x] Worker vitest (AC #18); the Playwright E2E additions (AC #19); the contract tests (AC #20).
  - [x] Run all gates on Node 22 (AC #21); fill the Dev Agent Record + Change Log.

## Dev Notes

### Why the confirmation enqueue lives inside `set_member_sms_opt_out` (not a separate RPC)

The "sent **once**" guarantee (AC #7) is the deciding factor. `set_member_sms_opt_out` already early-returns when the member is *already* opted out — that idempotency was built in Story 6.5. Placing the `opt_out_confirmation` INSERT *after* that early-return means a saver who reloads `POST /opt-out` (or double-submits) hits the no-op path and enqueues nothing. A separate `enqueue_*` RPC called by the Worker would need its own idempotency guard (and `sms_queue` rows have no `member_id` column to dedupe on cleanly — `transaction_id` is NULL here). Inlining reuses the existing guard for free, keeps the flip + the enqueue in one transaction, and needs no Worker round-trip change.

The `p_via = 'receipt_url'` gate keeps the confirmation scoped to this story's surface — STOP-keyword and collector-action opt-outs are untouched (AC #10). `anonymise_member` (Story 10.4) does its own `members` UPDATE and never calls `set_member_sms_opt_out`, so anonymisation never triggers a confirmation either.

### The confirmation SMS bypasses the opt-out gate — by construction

A normal transactional SMS is enqueued by the `enqueue_sms_on_transaction` trigger, which short-circuits when `members.sms_opt_out = true`. The confirmation SMS must be sent *despite* the flag being true. It is enqueued by a **direct `INSERT INTO sms_queue`** — the trigger is not in that path — and it runs *after* the flag flips. This is the exact pattern `enqueue_dispute_ack` uses for the dispute acknowledgement (a transactional response to a saver action, sent regardless of opt-out). `transaction_id` is `NULL` because the opt-out is member-scoped; the `claim_sms_queue_batch` drain `LEFT JOIN`s `transactions`, so a NULL `transaction_id` row is claimed normally, and `sms-worker`'s per-row undone-check is already guarded on `transaction_id !== null`.

The `sms-worker`'s `optedOut = false` placeholder (a Story 6.5 carry-over that never wired the worker-side opt-out gate) is **left as-is** — see the story header. The enqueue-time trigger gate already satisfies "no further transactional SMS"; touching the placeholder is a separate concern and would force an `opt_out_confirmation` exemption.

### The `anonymised_at` gate — two RPCs, two surfaces

The receipt page (`GET /r/{token}`) resolves via `get_receipt_payload`; the opt-out routes resolve via `get_member_id_from_token`. Both must learn `anonymised_at`, so both are re-derived. `get_member_id_from_token` changes its return *type* (scalar `uuid` → a row) — that requires `DROP FUNCTION` then `CREATE`, not `CREATE OR REPLACE`; the Worker's `fetchMemberIdFromToken` must adapt to read `data[0].member_id`. Same for `get_receipt_payload` (adding a `RETURNS TABLE` column). Re-grant `EXECUTE` after each `CREATE` — the receipt-URL Worker calls these unauthenticated, so the grant (likely to `anon`) must be preserved exactly.

An anonymised member reaching the opt-out POST would be a harmless no-op anyway (`anonymise_member` already set `sms_opt_out = true` → `set_member_sms_opt_out` idempotent-returns), and their phone is destroyed so no confirmation SMS could send. The 404 (AC #12/#13) is correctness/coherence, not a security fix.

### The `format_sms_body` rebase discipline

`format_sms_body` MUST be `CREATE OR REPLACE`d from its **latest** definition — `20260516203656` (Story 10.2, which added `dispute_ack`), not an older one. Stories 9.3 / 10.1 each hit a bug from rebasing a shared function on a stale baseline. The psql smoke test (Task 4) must verify all four prior templates still render after the rebase.

### Project Structure Notes

- New: one migration `supabase/migrations/<timestamp>_optout-confirmation-and-anonymised-gate.sql`.
- Modified by `CREATE OR REPLACE` / `DROP`+`CREATE` (no new files): `format_sms_body`, `set_member_sms_opt_out`, `get_receipt_payload`, `get_member_id_from_token`; the `sms_queue.template_key` CHECK.
- Modified: `workers/receipt-url/src/render.ts` + `index.ts` (+ their `.test.ts`); `supabase/functions/sms-worker/index.ts` (one type-union line); `tests/e2e/receipt-url-worker.spec.ts`; the relevant `_shared/*.contract.test.ts`.
- No `src/` (React app) change, no `package.json` change.
- The receipt-URL opt-out *routes, RPC, HTML and footer link already exist* (Story 6.5) — 10.5 EXTENDS them; it does not rebuild them.

### References

- **Epic spec:** `epics.md:1390-1405` (Story 10.5 BDD), `epics.md` FR32 (the action-surface requirement).
- **PRD:** FR32 — the saver SMS-consent / opt-out action surface.
- **Architecture:** the receipt-URL Cloudflare Worker; the SMS pipeline (enqueue trigger → `sms_queue` → `sms-worker` → Termii).
- **Existing code — the Worker:** `workers/receipt-url/src/index.ts` (the route table; the `GET`/`POST /r/{token}/opt-out` handlers; `fetchMemberIdFromToken`, `setMemberSmsOptOut`, `fetchReceiptPayload`), `src/render.ts` (`renderReceiptHtml`, `renderSettlementReceiptHtml`, `renderOptOutFormHtml`, `renderOptOutConfirmedHtml`, the `ReceiptPayload` type, the footer opt-out `<section>`), `src/token.ts` (`tokenIsValid`).
- **Existing code — migrations:** `20260501000004_set_member_sms_opt_out.sql` (the RPC to extend), `20260516203656_dispute-notify-trigger-and-enqueue.sql` (the **current** `format_sms_body` + the `enqueue_dispute_ack` enqueue pattern + the latest `template_key` CHECK), `20260515000002_get_receipt_payload_cycle_dates.sql` (the current `get_receipt_payload`), `20260501000005_get_member_id_from_token.sql` (the current `get_member_id_from_token`), `20260516225824_saver-anonymisation.sql` (Story 10.4 — `members.anonymised_at`), `20260501000002_enqueue_sms_optout_check.sql` (the enqueue-time opt-out gate), `20260419000005_vault_setup.sql` (`vault_decrypt`).
- **Existing code — the sms-worker:** `supabase/functions/sms-worker/index.ts` (the `ClaimedRow` `template_key` union; the `optedOut` placeholder).
- **Existing tests:** `workers/receipt-url/src/render.test.ts` (the Story 6.5 opt-out render cases), `tests/e2e/receipt-url-worker.spec.ts` (the Story 6.5 opt-out E2E cases), `supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts`, `_shared/format-sms-body.contract.test.ts`, `_shared/sms-templates-length.contract.test.ts`, `_shared/sms-templates-banking-language.contract.test.ts`.
- **Previous stories:** `6-5-first-sms-consent-optout.md` (built the opt-out plumbing; deferred the confirmation SMS), `10-4-saver-anonymisation-edge-function.md` (`anonymised_at`; `deferred-work.md` notes "if Story 10.5 needs `sms_opt_out_via` it can expose it then" — 10.5 does not need it), `10-2-dispute-notify-edge-function.md` (the `enqueue_dispute_ack` ungated-enqueue pattern).
- **CLAUDE.md:** `db:migrate` not `db:reset`; rebase shared functions on their latest definition; no new deps for trivial needs.
- **Memory:** `feedback_migration_rpc_smoke_test.md` (psql-smoke-test RPC migrations), `feedback_npm_lockfile_node_version.md` (Node 22), `feedback_run_coverage_locally.md`, `feedback_push_then_ci_failure.md`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **`format_sms_body` rebase baseline.** The latest in-DB definition (verified via `pg_get_functiondef`) is the post-10.2 body with the `dispute_ack` template — sourced from `20260515000001` + the 10.2 dispute work. The migration `CREATE OR REPLACE`s from that exact body; the `opt_out_confirmation` branch returns BEFORE the transaction fetch (it ignores `p_transaction_id`).
- **`get_member_id_from_token` return-type change.** Scalar `uuid` → `RETURNS TABLE(member_id, anonymised_at)` requires `DROP` + `CREATE` (not `CREATE OR REPLACE`). The Worker's helper was renamed `fetchMemberIdFromToken` → `fetchMemberFromToken` and now reads the PostgREST row array `[{ member_id, anonymised_at }]`.
- **`test:edge` shared-state flakiness.** The full `test:edge` run shows 11 failures — 8 `sms-inbound` + 2 `sms-worker` (the pre-existing local Termii-secret gap) + 1 order-dependent `reject-transaction-on-closed-cycle`. All five files this story touched/added (`format-sms-body`, `set-member-sms-opt-out` +tests 7/8, `sms-templates-length`, `sms-templates-banking-language`, plus `reject-transaction-on-closed-cycle`) pass **27/27 when run in isolation** — confirming the failures are pre-existing flakiness, not a regression. CI runs on a clean isolated stack.
- **`node_modules` / `deno.lock` pollution.** The Deno runs repopulate `node_modules/.deno/` (breaks vitest) and rewrite `deno.lock`. Restored via `npm ci`; reverted `deno.lock` (Story 10.5 adds no Deno deps).

### Completion Notes List

- **Migration `20260517001214_optout-confirmation-and-anonymised-gate.sql`** — (1) `format_sms_body` `CREATE OR REPLACE`d + an `opt_out_confirmation` static branch (the 4 prior templates preserved verbatim); (2) the `sms_queue_template_key_chk` CHECK dropped + re-added with `'opt_out_confirmation'`; (3) `set_member_sms_opt_out` `CREATE OR REPLACE`d — after the idempotent early-return + the `members` UPDATE, when `p_via = 'receipt_url'`, a direct `INSERT` of an `opt_out_confirmation` `sms_queue` row (`transaction_id` NULL, ungated, the decrypted phone resolved via `vault_decrypt`; a phone-less saver → no row); (4) `get_receipt_payload` `DROP`+`CREATE` + `anonymised_at`; (5) `get_member_id_from_token` `DROP`+`CREATE` → `RETURNS TABLE(member_id, anonymised_at)`.
- **The confirmation SMS** — static accent-free body `"SafariCash. Vous ne recevrez plus de SMS. Pour les reactiver, contactez votre collecteur."` (89 chars — single GSM-7 segment; banking-language-clean). Sent exactly once (the idempotent early-return is the dedup); only on `p_via = 'receipt_url'`.
- **The Worker** — `render.ts`: `ReceiptPayload` + `anonymised_at`; `renderReceiptHtml` + `renderSettlementReceiptHtml` omit the `<section class="opt-out">` block (via the new `optOutSection` helper) when `anonymised_at` is set; `renderOptOutConfirmedHtml` copy now mentions the confirmation SMS. `index.ts`: `fetchMemberFromToken` adapts to the new row shape; the `GET` + `POST /opt-out` handlers 404 an anonymised saver (the `GET` now does a DB lookup, wrapped in try/catch).
- **`sms-worker`** — the `ClaimedRow` `template_key` union gains `"opt_out_confirmation"` (type-only; no behavioural change — the `optedOut` placeholder left untouched per scope).
- **psql smoke test** (`begin`/`rollback`) — `format_sms_body('opt_out_confirmation', null)` → the 89-char body; `format_sms_body('dispute_ack', tx)` still renders (rebase preserved); `get_receipt_payload` / `get_member_id_from_token` return `anonymised_at`; `set_member_sms_opt_out(m, 'receipt_url')` → exactly 1 `opt_out_confirmation` queued row + `sms.opt_out` audit; a 2nd `receipt_url` call → still 1 row (idempotent); a `stop_keyword` opt-out → 0 confirmation rows.
- **Gates** (Node 22): typecheck ✓ · lint --max-warnings=0 ✓ · 990 vitest passed (+4 Worker render tests) ✓ · build ✓ · the 5 touched/added edge contract test files 27/27 green in isolation ✓ · `receipt-url-worker` Playwright 11/11 green (incl. the new anonymised-gate test + the extended opt-out test asserting the `opt_out_confirmation` row).

### File List

**New:**
- `supabase/migrations/20260517001214_optout-confirmation-and-anonymised-gate.sql`

**Modified:**
- `workers/receipt-url/src/render.ts` — `ReceiptPayload` + `anonymised_at`; the `optOutSection` helper + the anonymised gate; `renderOptOutConfirmedHtml` copy (+ `render.test.ts`).
- `workers/receipt-url/src/index.ts` — `fetchMemberFromToken` (the new RPC row shape); the `GET`/`POST /opt-out` anonymised-saver 404.
- `supabase/functions/sms-worker/index.ts` — the `ClaimedRow` `template_key` union.
- `supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts` — tests 7 (the `receipt_url` confirmation enqueue + idempotency) and 8 (the `stop_keyword` no-enqueue).
- `supabase/functions/_shared/sms-templates-length.contract.test.ts` + `sms-templates-banking-language.contract.test.ts` — the `opt_out_confirmation` template added to the iterated set.
- `tests/e2e/receipt-url-worker.spec.ts` — the `opt_out_confirmation` SMS assertion + the anonymised-saver gate E2E.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-17 | Story 10.5 implemented via bmad-dev-story on `feat/10-5-saver-optout-action` — 7 tasks / 21 ACs; FIFTH and FINAL story of Epic 10. ONE migration `20260517001214`: `format_sms_body` + an `opt_out_confirmation` static template; the `sms_queue.template_key` CHECK + `'opt_out_confirmation'`; `set_member_sms_opt_out` enqueues the confirmation SMS via a direct `INSERT` after its idempotent early-return, only when `p_via='receipt_url'` (sent once, `transaction_id` NULL, ungated like `enqueue_dispute_ack`); `get_receipt_payload` + `get_member_id_from_token` `DROP`+`CREATE`d to return `anonymised_at`. The receipt-URL Worker (`render.ts`/`index.ts`) hides the footer opt-out link + 404s the opt-out routes for an anonymised saver; the confirmed page mentions the SMS. `sms-worker` `ClaimedRow` type-union line. NO `src/` change, NO new dependency, NO re-opt-in, NO touch to the `sms-worker` `optedOut` placeholder. psql-smoke-tested. Gates green: typecheck / lint / 990 vitest / build / receipt-url-worker Playwright 11/11 / the 5 touched edge contract files 27/27 in isolation (the 11 `test:edge` full-run failures are the pre-existing `sms-inbound`/`sms-worker` Termii-secret gap + shared-state flakiness). | Dev agent (claude-opus-4-7[1m]) |
| 2026-05-17 | Story 10.5 drafted via bmad-create-story — FIFTH and FINAL story of Epic 10 (Saver Dispute Flow & Data Rights). Story 6.5 already shipped the receipt-URL opt-out plumbing (routes, `set_member_sms_opt_out` RPC, footer link, form/confirmed pages); 10.5 completes the two pieces 6.5 left: (1) the final confirmation SMS — a new `opt_out_confirmation` template in `format_sms_body` + the `sms_queue.template_key` CHECK; `set_member_sms_opt_out` extended to enqueue it via a direct `INSERT` (after the idempotent early-return, only when `p_via='receipt_url'` — sent exactly once, scoped to the receipt-URL surface, `transaction_id` NULL, ungated like `enqueue_dispute_ack`); (2) the `anonymised_at` gate — `get_receipt_payload` + `get_member_id_from_token` re-derived to return `anonymised_at`, the Worker hides the footer opt-out link and 404s the opt-out routes for an anonymised member. ONE migration. Worker changes (`render.ts` / `index.ts`) + one `sms-worker` type-union line. NO `src/` change, NO new dependency, NO re-opt-in mechanism, NO touch to the `sms-worker` `optedOut` placeholder. 21 ACs / 7 tasks. | Spec author (claude-opus-4-7[1m]) |

## Review Findings

**Reviewed:** 2026-05-17 · `bmad-code-review` · 3-layer adversarial (Blind Hunter / Edge Case Hunter / Acceptance Auditor, sonnet-4-6) on the staged diff of `feat/10-5-saver-optout-action` (11 files, +856/−25).

**Verdict:** APPROVE WITH PATCHES. No Critical / High defects confirmed. The `format_sms_body` and `set_member_sms_opt_out` rebases are byte-for-byte clean (Edge Case Hunter verified — every prior branch preserved). Two Blind-Hunter "High"s were debunked by the project-aware layers: `'resend'` in the re-added CHECK is a correctly-preserved Story-6.6 value, and the `service_role`-only grants on `get_receipt_payload` / `get_member_id_from_token` match the prior definitions exactly — the Worker calls them with the service-role key (the receipt-url-worker E2E passing 11/11 confirms it). 8 patches (Low/Medium), the rest dismissed.

### Patches to apply (P1–P8)

- [x] [Review][Patch] **P1 — `format_sms_body`: re-state the EXECUTE grants (Medium)** [`supabase/migrations/20260517001214_optout-confirmation-and-anonymised-gate.sql`]. The `CREATE OR REPLACE` omits the `grant execute … to authenticated, service_role; revoke … from public;` block that `20260515000001` carries. `CREATE OR REPLACE` preserves grants so there is no live breakage — but the project's self-contained-migration discipline (Story 7.5 CR patch #4) wants them re-stated. Add the grant block after the function.
- [x] [Review][Patch] **P2 — `set_member_sms_opt_out`: resolve the phone in the initial SELECT (Low)** [`supabase/migrations/20260517001214_*.sql`]. The phone is read by a SECOND `SELECT … FROM members` after the `UPDATE`. Fold `vault_decrypt(phone_number_encrypted)` into the initial `SELECT collector_id, sms_opt_out … INTO …` — removes the redundant round-trip and the (tiny) race window where a concurrent committed `anonymise_member` could swap in the hashed phone between the UPDATE and the second SELECT.
- [x] [Review][Patch] **P3 — the `template_key` CHECK swap: use `NOT VALID` + `VALIDATE` + the `comment on constraint` (Low→Medium)** [`supabase/migrations/20260517001214_*.sql`]. The plain `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` validates synchronously — a full-table lock-scan on a large `sms_queue`. Match `20260512000001`: `ADD CONSTRAINT … CHECK (…) NOT VALID;` then `ALTER TABLE … VALIDATE CONSTRAINT …;` + re-add the `comment on constraint`.
- [x] [Review][Patch] **P4 — add an `opt_out_confirmation` case to `format-sms-body.contract.test.ts` (Medium)** [`supabase/functions/_shared/format-sms-body.contract.test.ts`]. AC #20 requires `format_sms_body('opt_out_confirmation', NULL)` be verified in the format-sms-body contract suite — that file was not touched. Add a case asserting the exact static body.
- [x] [Review][Patch] **P5 — `sms-worker` `ClaimedRow.template_key` union: also add `'resend'` (Low)** [`supabase/functions/sms-worker/index.ts`]. The diff adds `opt_out_confirmation` but `'resend'` (a valid `template_key` CHECK value since Story 6.6) was never in the union — a pre-existing type gap. While editing this exact line, make the union match the CHECK: add `'resend'` too.
- [x] [Review][Patch] **P6 — the anonymised-gate E2E: seed via the `anonymise_member` RPC, not a raw UPDATE (Low→Medium)** [`tests/e2e/receipt-url-worker.spec.ts`]. The test stamps `anonymised_at` with a direct `members` UPDATE — a state unreachable in production (`anonymise_member` always also sets `sms_opt_out`). Call the `anonymise_member` RPC instead so the fixture is production-faithful.
- [x] [Review][Patch] **P7 — assert `recipient_phone` on the `opt_out_confirmation` row (Low)** [`tests/e2e/receipt-url-worker.spec.ts`, `supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts`]. AC #19 says the row carries "the member's phone" — both the E2E and Deno contract test 7 select `recipient_phone` but never assert it. Assert it equals the seeded phone.
- [x] [Review][Patch] **P8 — fix the `format_sms_body` migration comment (Low)** [`supabase/migrations/20260517001214_*.sql`]. The comment cites "20260515000001 + the 10.2 dispute_ack addition" — but `dispute_ack` was already present in `20260515000001`. Correct the comment to cite the actual single baseline.

### Dismissed (7)

`'resend'` in the re-added CHECK flagged as "unknown origin" (Blind Hunter, diff-only — Edge Case Hunter confirmed it is a Story-6.6 value, correctly preserved); the `service_role`-only grants on `get_receipt_payload` / `get_member_id_from_token` flagged as a narrowing from `anon` (both functions were ALREADY `service_role`-only — the prior definitions `20260515000002` / `20260501000005` grant exactly that; the Worker uses the service-role key; the E2E 11/11 confirms); `renderOptOutConfirmedHtml` over-claiming "an SMS was sent" for a phone-less saver (a cash-only saver has no transactional SMS to opt out of — a non-scenario; plumbing a `smsSent` signal is disproportionate); `GET /opt-out` returning 404 on a DB error (the pre-existing Worker pattern — `fetchReceiptPayload` does the same; not 10.5's scope to redesign); the `p_via` allowlist excluding `'anonymisation'` (pre-existing — already in `deferred-work.md` from the 10.4 review); `fetchReceiptPayload` not explicitly changed (the `anonymised_at` field flows correctly via TypeScript structural typing); the length/banking contract tests passing a `txId` rather than `NULL` for `opt_out_confirmation` (works correctly — the branch ignores `p_transaction_id`; P4 adds the explicit-NULL contract).

### Patch Resolution — 2026-05-17

All 8 patches (P1–P8) applied:

- **P1** — the migration re-states `grant execute on format_sms_body … to authenticated, service_role; revoke … from public;` after the `CREATE OR REPLACE`.
- **P2** — `set_member_sms_opt_out` resolves `vault_decrypt(phone_number_encrypted)` in the SAME initial `SELECT` as `collector_id`/`sms_opt_out` (one row read; the redundant second SELECT + its race with `anonymise_member` removed).
- **P3** — the `sms_queue_template_key_chk` swap now uses `ADD CONSTRAINT … NOT VALID` + a separate `VALIDATE CONSTRAINT` + a re-added `comment on constraint` (no synchronous lock-scan).
- **P4** — `format-sms-body.contract.test.ts` gains test 9: `format_sms_body('opt_out_confirmation', NULL)` returns the exact static body.
- **P5** — the `sms-worker` `ClaimedRow.template_key` union also gains `'resend'` — the union now matches the `template_key` CHECK exactly.
- **P6** — the anonymised-gate E2E now seeds via the `anonymise_member` RPC (a production-faithful fixture) instead of a raw `anonymised_at` UPDATE.
- **P7** — both the E2E and Deno contract test 7 now assert `recipient_phone` on the `opt_out_confirmation` row.
- **P8** — the `format_sms_body` migration comment corrected (the `20260515000001` baseline already carries `dispute_ack`).

**Gates re-run (Node 22):** typecheck ✓ · lint --max-warnings=0 ✓ · 990 vitest passed ✓ · build ✓ · the 5 touched edge contract files 32/32 green in isolation (incl. the new `format-sms-body` test 9; the 2 `sms-worker` failures are the pre-existing Termii-mock-key flakiness — `ClaimedRow` is a type-only change) ✓ · `receipt-url-worker` Playwright 11/11 green (incl. the `anonymise_member`-seeded gate test + the `recipient_phone` assertion) ✓ · the patched migration re-applied + re-smoke-tested — `receipt_url` enqueues 1 `opt_out_confirmation` / `stop_keyword` enqueues 0 / idempotent. Story status → `done`.
