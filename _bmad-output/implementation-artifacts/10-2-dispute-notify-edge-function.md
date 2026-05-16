# Story 10.2: dispute-notify Edge Function (collector + founder notification)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer**,
I want **an Edge Function that fans a flagged dispute out to the responsible parties — the saver (SMS ack), the founder (email), and the collector (Realtime)**,
so that **every dispute reaches the people who must act on it within minutes (FR33b, AR12).**

> **Predicate of this story. SECOND story of Epic 10 (Saver Dispute Flow & Data Rights).** Story 10.1 shipped the dispute *capture* — the receipt-URL Worker's `flag_transaction_dispute` RPC inserts a `public.disputes` row + the `audit_disputes` trigger hash-chains a `dispute.flagged` audit event. Story 10.2 ships the dispute *fan-out*: a `dispute-notify` Edge Function, triggered on the `disputes` INSERT, that drives four notification outputs.
>
> **What 10.2 ships — the `dispute-notify` Edge Function + its trigger:**
> 1. **The invocation.** One migration adds an `AFTER INSERT ON public.disputes` trigger that `pg_net.http_post`s to `/functions/v1/dispute-notify` — the same `pg_net` + Vault-secrets pattern as the `sms-worker` cron (`20260428000002`), but per-row instead of time-based. The dispute INSERT is committed by `flag_transaction_dispute` (idempotent — fires once per genuine new dispute).
> 2. **The SMS ack to the saver.** The function enqueues a `dispute_ack` SMS — a new `enqueue_dispute_ack` SECURITY DEFINER RPC inserts into `sms_queue` (`template_key='dispute_ack'`, body via the *already-built* `format_sms_body('dispute_ack', transaction_id)`); the existing `sms-worker` sends it on its next 30 s tick.
> 3. **The email to the founder.** The function emails the founder (`FOUNDER_SUPPORT_EMAIL`) via **Resend** (`https://api.resend.com/emails`, a minimal `fetch` client in `_shared/` — mirrors `termii-client.ts`, no SDK). "Email must work at MVP" (FR33b).
> 4. **The Realtime emit to the collector.** The function sends a Supabase Realtime `broadcast` on a collector-scoped channel (`disputes:{collector_id}`) — the architecture's one sanctioned Realtime use (Q-ARCH6).
> 5. **Push — a logged no-op stub.** Real push is Growth (PRD line 384 "MVP: no push"); the function records the intent in a structured log line only.
>
> **Each of the four outputs is independent best-effort.** A Resend outage must not block the SMS; a missing `RESEND_API_KEY` must not 500 the function. The dispute is already recorded + audited by Story 10.1 — `dispute-notify` is the delivery layer, not the source of truth. The function returns `200` with a per-output status object.
>
> **Reconciliations vs the epic AC (the epic text predates the 10.1/10.2 split):**
> - The epic says `dispute-notify` "logs a `dispute.flagged` audit event" — **Story 10.1 already does this** via the `audit_disputes` trigger. 10.2 adds NO audit event and NO `audit_append_external` change (a second `dispute.flagged` would double the chain).
> - The epic says the Realtime event is "subscribed by the collector's app" — 10.2 ships the **server-side emit only**. The client-side subscription + the in-app toast belong with the collector-side dispute surface in **Story 10.3** (where they pair naturally with the member-profile banner). 10.2's emit is latent until 10.3 consumes it — an accepted, clean slice.
>
> **Code-reuse map (DO NOT re-invent):**
> - **Edge Function anatomy** — `supabase/functions/sms-worker/index.ts` is the closest precedent: invoked by `pg_net`, authenticates the service-role caller itself (`verify_jwt` default + a manual service-role check), `_shared/auth-check.ts` (`buildServiceClient`), `_shared/rfc7807.ts` (`problem` / `problemResponse`). `re-auth/index.ts` is the `export async function handler` + guarded `Deno.serve` variant — use it so the function is unit-testable.
> - **`pg_net` invocation** — `supabase/migrations/20260428000002_schedule_sms_worker.sql`: `net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name='project_url'), headers := …'Bearer '||…'service_role_key'…, body := …)` with a `WHERE EXISTS (…vault…)` guard so it no-ops on an unseeded local stack. Copy this verbatim, as an `AFTER INSERT` trigger body.
> - **`dispute_ack` SMS** — `format_sms_body('dispute_ack', p_transaction_id)` ALREADY EXISTS (`20260429000002` + `20260515000001`): renders `'SafariCash. Votre signalement a ete recu. Reponse sous 48h. Reference: %s.'` (first 8 chars of the newest `disputes.id` for the transaction). `dispute_ack` is ALREADY a valid `sms_queue.template_key` CHECK value + a typed `sms-worker` `ClaimedRow` key. The enqueue path is the only missing piece.
> - **The enqueue pattern** — `enqueue_resend_transaction` (`20260513000002`) is the canonical SECURITY DEFINER "resolve phone + build body + INSERT into `sms_queue`" RPC. `enqueue_dispute_ack` mirrors it.
> - **External-HTTP client** — `supabase/functions/_shared/termii-client.ts` — a minimal `fetch` wrapper for an external API. `email-client.ts` mirrors its shape.
> - **The Deno test pattern** — `_shared/test-fixtures.ts` (`seedCollector`, `seedMemberWithCycle`, `cleanup`, `installFetchRecorder`), `run-edge-tests.sh` registration.
>
> **What Story 10.2 does NOT ship:**
> - The client-side Realtime subscription / the in-app dispute toast (→ **Story 10.3**).
> - The collector member-profile dispute banner + the history dispute icon + manual resolution (→ **Story 10.3**).
> - Real push delivery — Web Push / VAPID / FCM (Growth; 10.2 ships a logged stub only).
> - Saver anonymisation (10.4); the receipt-URL opt-out action (10.5).
> - Any change to Story 10.1's `flag_transaction_dispute` RPC or the receipt-URL Worker.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1347-1354`; the rest are spec-derived constraints.

### Invocation

1. **Given** a `public.disputes` row is inserted (by `flag_transaction_dispute`), **When** the INSERT commits, **Then** an `AFTER INSERT` trigger `pg_net.http_post`s to `/functions/v1/dispute-notify` with a JSON body `{ dispute_id, transaction_id, collector_id }`. The trigger reads the function URL + service-role key from `vault.decrypted_secrets` (`project_url` / `service_role_key`) and is `WHERE EXISTS`-guarded so it cleanly no-ops on an unseeded (local) stack.

2. **`dispute-notify` is service-role-only.** The function asserts the caller presents the service-role bearer token (the `sms-worker` manual-check pattern); a non-service-role / missing token → RFC-7807 `401`. It is invoked server-side by `pg_net`, never by a browser — no `operation_intent` / re-auth.

3. **Idempotent-by-construction.** `flag_transaction_dispute` only INSERTs for a genuinely new dispute (an existing `open` dispute → `already_disputed`, no INSERT), so the trigger fires exactly once per dispute. The function does NOT need its own dedup, but a malformed/duplicate invocation must not crash — an unknown `dispute_id` → `200` with all outputs `skipped`, logged.

### Output 1 — the saver SMS acknowledgment

4. **Given** the function runs, **Then** it enqueues a `dispute_ack` SMS to the saver — via a new `enqueue_dispute_ack(p_transaction_id uuid)` SECURITY DEFINER RPC that resolves the saver's decrypted phone (`vault_decrypt(members.phone_number_encrypted)`), builds the body with `format_sms_body('dispute_ack', p_transaction_id)`, and INSERTs a `sms_queue` row (`template_key='dispute_ack'`, `status='queued'`, `collector_id`, `transaction_id`, `recipient_phone`).

5. **The existing `sms-worker` sends it.** No `sms-worker` change — `dispute_ack` is already a typed `ClaimedRow` key; the enqueued row drains on the next 30 s tick.

6. **The `dispute_ack` SMS ignores `members.sms_opt_out`.** It is a transactional response to the saver's own explicit action (it carries the dispute reference number they need to follow up) — not an unsolicited notification. `enqueue_dispute_ack` does NOT gate on the opt-out flag. (Documented decision — see Dev Notes.)

7. **Sequencing.** The `disputes` row exists before `dispute-notify` runs (the trigger fires AFTER INSERT), so `format_sms_body('dispute_ack', …)`'s lookup of the newest `disputes.id` resolves the correct reference.

### Output 2 — the founder email

8. **Given** the function runs, **Then** it emails the founder at `FOUNDER_SUPPORT_EMAIL` via Resend (`POST https://api.resend.com/emails`, `Authorization: Bearer ${RESEND_API_KEY}`). The email states: a dispute was flagged, the collector, the transaction (amount + date), the saver's optional free-text note, and the flagged-at timestamp. Subject + body in French.

9. **Email is best-effort + degrades cleanly.** A missing `RESEND_API_KEY` or `FOUNDER_SUPPORT_EMAIL` → the email output is `skipped` (structured log), NOT a 500. A Resend non-2xx / network error → the email output is `failed` (logged), and the other three outputs still run. "Email must work at MVP" — the path is fully built; the secrets are operator-provisioned.

10. **The Resend call is a minimal `fetch` client** in `supabase/functions/_shared/email-client.ts` (mirrors `termii-client.ts`) — no npm/Deno SDK dependency.

### Output 3 — the collector Realtime emit

11. **Given** the function runs, **Then** it emits a Supabase Realtime `broadcast` (event e.g. `dispute_flagged`) on a collector-scoped channel `disputes:{collector_id}`, carrying `{ dispute_id, transaction_id, member_id, flagged_at }` (NO saver PII in the payload — ids only). This is the architecture's single sanctioned Realtime use (Q-ARCH6).

12. **Emit-only.** 10.2 ships the server-side emit. The client-side subscription + the in-app toast are Story 10.3. A Realtime emit failure is best-effort (logged, non-fatal).

### Output 4 — the founder push (stub)

13. **Push is a logged no-op stub.** The function records the push *intent* in a structured log line (`level:"info", event:"dispute_notify.push_stub"`) — NO real delivery. Real push (Web Push / VAPID) is Growth (PRD line 384). The epic AC's "enqueues a push notification … deferred to Growth if push infra not ready" is satisfied by the logged stub.

### The function contract

14. **Response shape.** `dispute-notify` returns `200` with `{ ok: true, outputs: { sms: "...", email: "...", realtime: "...", push: "stub" } }` where each value is `sent` / `queued` / `skipped` / `failed`. A genuinely unrecoverable input (no JSON body, no `dispute_id`) → RFC-7807 `400 request_invalid`. The function NEVER 500s on a single failed output.

15. **No saver PII in logs.** Structured JSON logs only; never log the saver's phone, name, or the dispute free-text. Token/phone prefixes at most (mirrors the receipt-URL Worker's `tokenPrefix` discipline).

### Config, migration, hygiene

16. **Migration.** One migration: (a) the `AFTER INSERT ON public.disputes` `pg_net` trigger + its function; (b) the `enqueue_dispute_ack(p_transaction_id uuid)` SECURITY DEFINER RPC (`GRANT EXECUTE … TO service_role`, `REVOKE` from `public`/`anon`/`authenticated`, `search_path`-pinned). `npm run db:migrate` (NOT `db:reset`); `psql`-smoke-test the RPC before push.

17. **`config.toml` + secrets.** Add `RESEND_API_KEY` + `FOUNDER_SUPPORT_EMAIL` to `[edge_runtime.secrets]` (the `KEY = "env(KEY)"` pattern). `dispute-notify` keeps the default `verify_jwt` (service-role JWT passes) + a manual service-role assertion. Add `RESEND_API_KEY` to `.env.example` (`FOUNDER_SUPPORT_EMAIL` is already declared there).

18. **No new npm dependency.** Resend via `fetch`; Realtime via the already-bundled `@supabase/supabase-js`; `pg_net` is an existing extension.

19. **Tests — Deno.** `supabase/functions/dispute-notify/index.test.ts` — the function: service-role gate (401), bad body (400), the happy path enqueues a `sms_queue` row + returns the per-output status, a missing-secret email path → `skipped` not 500, an unknown `dispute_id` → all `skipped`. Mock the Resend `fetch` via `installFetchRecorder`. A `_shared/*.contract.test.ts` for `enqueue_dispute_ack` (enqueues a chain-valid `sms_queue` row; opt-out is ignored). The `AFTER INSERT` trigger's existence/shape. Register every new test file in `scripts/run-edge-tests.sh`.

20. **All gates green** (Node 22 / npm 10): `npm run typecheck`; `npm run lint --max-warnings=0`; `npm run test -- --coverage` (no app-code change expected — confirm still green); `npm run build`; `npm run test:edge` (the new `dispute-notify` + `enqueue_dispute_ack` tests pass); `npx playwright test` — the full suite incl. `flow-9-csv-export` / `receipt-url-worker` no-regression. Pre-push: `nvm use 22`, coverage locally, `psql`-smoke-test the migration, grep stale assertions.

## Tasks / Subtasks

- [x] **Task 1 — Migration: the `enqueue_dispute_ack` RPC** (AC: #4, #6, #16)
  - `npm run db:migrate:new dispute-notify-trigger-and-enqueue`.
  - `enqueue_dispute_ack(p_transaction_id uuid)` — SECURITY DEFINER, `search_path`-pinned: resolve `members.phone_number_encrypted` → `vault_decrypt`; build body via `format_sms_body('dispute_ack', p_transaction_id)`; INSERT into `sms_queue` (`template_key='dispute_ack'`, `status='queued'`, `retry_count=0`, `collector_id`/`transaction_id`/`recipient_phone`). Does NOT check `sms_opt_out`. `GRANT EXECUTE … TO service_role`; `REVOKE` from `public`/`anon`/`authenticated`.

- [x] **Task 2 — Migration: the `AFTER INSERT` `pg_net` trigger on `disputes`** (AC: #1, #16)
  - Same migration file: a trigger function that `net.http_post`s to `{project_url}/functions/v1/dispute-notify` with `{ dispute_id, transaction_id, collector_id }`, `Authorization: Bearer {service_role_key}` — Vault-secret lookups + `WHERE EXISTS` guard, mirroring `20260428000002`. `create trigger … after insert on public.disputes`.
  - `npm run db:migrate`; `psql`-smoke-test `enqueue_dispute_ack` (an enqueued `sms_queue` row, body rendered, opt-out ignored).

- [x] **Task 3 — `_shared/email-client.ts`** (AC: #8, #10)
  - A minimal Resend `fetch` client: `sendEmail({ to, subject, html|text })` → `POST https://api.resend.com/emails`. Reads `RESEND_API_KEY`. Returns a discriminated result (`sent` / `skipped` / `failed`); never throws.

- [x] **Task 4 — `dispute-notify/index.ts`** (AC: #2, #3, #11, #12, #13, #14, #15)
  - `export async function handler` + guarded `Deno.serve`. Service-role assertion. Parse `{ dispute_id, transaction_id, collector_id }`. Resolve the dispute/transaction/collector. Run the 4 outputs independently best-effort: (1) `supabase.rpc('enqueue_dispute_ack', …)`; (2) `sendEmail(...)` to the founder; (3) Realtime `broadcast` on `disputes:{collector_id}`; (4) the push log stub. Return `{ ok, outputs }`.

- [x] **Task 5 — `config.toml` + `.env.example`** (AC: #17)
  - `[edge_runtime.secrets]`: `RESEND_API_KEY`, `FOUNDER_SUPPORT_EMAIL`. `.env.example`: add `RESEND_API_KEY`.

- [x] **Task 6 — Deno tests** (AC: #19)
  - `dispute-notify/index.test.ts` + a `_shared/enqueue-dispute-ack.contract.test.ts`. Register both in `scripts/run-edge-tests.sh`.

- [x] **Task 7 — Gate run + sprint hygiene** (AC: #20)
  - All gates green on Node 22; full Playwright suite locally (no-regression).
  - `sprint-status.yaml`: `10-2-dispute-notify-edge-function` `ready-for-dev → review`; `last_updated` + touched line.

### Review Findings

> Cross-LLM adversarial review 2026-05-16 (claude-sonnet-4-6, 3 layers: Blind Hunter / Edge Case Hunter / Acceptance Auditor). 0 decision + 6 patch + ~10 dismissed as noise. All 6 patches applied. (One Blind Hunter "Critical" — `PERFORM … WHERE EXISTS` allegedly invalid SQL — was a false positive: it is valid PL/pgSQL, proven by `db:migrate` + the psql smoke test, and the Edge Case Hunter independently confirmed it.)

- [x] [Review][Patch] HIGH — `dispute_notify_trigger` URL ambiguity — FIXED: the trigger now reads a dedicated `dispute_notify_url` Vault secret (the FULL function URL, POSTed verbatim — no `project_url` concatenation, which the `sms-worker` cron treats differently); the `WHERE EXISTS` guard + the migration header's operator-setup note updated [supabase/migrations/20260516203656_dispute-notify-trigger-and-enqueue.sql]
- [x] [Review][Patch] MEDIUM — `dispute_notify_trigger` exception isolation — FIXED: the `net.http_post` is wrapped in `BEGIN … EXCEPTION WHEN OTHERS THEN RAISE WARNING … END` so a pg_net failure can never roll back the `disputes` INSERT [supabase/migrations/20260516203656_dispute-notify-trigger-and-enqueue.sql]
- [x] [Review][Patch] MEDIUM — `emitRealtime` — FIXED: `channel.send()`'s `"ok"|"error"|"timed out"` result is now inspected (`=== "ok" ? "sent" : "failed"`); `removeChannel` moved into a `finally` so the channel is released on every path [supabase/functions/dispute-notify/index.ts]
- [x] [Review][Patch] MEDIUM — founder email collector identifier — FIXED: the email now resolves + includes the collector's phone (`users.phone_number`), falling back to the UUID if the lookup returns nothing [supabase/functions/dispute-notify/index.ts]
- [x] [Review][Patch] LOW — output concurrency — FIXED: the three async outputs now run via `Promise.all` [supabase/functions/dispute-notify/index.ts]
- [x] [Review][Patch] LOW — test gaps — FIXED: added an `enqueue_dispute_ack` contract test asserting `sms_opt_out=true` is ignored; added the `realtime` assertion to the unknown-`dispute_id` handler test [supabase/functions/_shared/enqueue-dispute-ack.contract.test.ts, supabase/functions/dispute-notify/index.test.ts]

## Dev Notes

### How a `disputes` INSERT reaches the Edge Function

There is NO Database-Webhook / `supabase_functions` mechanism in this codebase. The only Postgres→Edge-Function path is `pg_net.http_post` (the `sms-worker` cron, `20260428000002`). Story 10.2 reuses that primitive as an `AFTER INSERT ON public.disputes` trigger: the trigger body `net.http_post`s to `dispute-notify`. `pg_net` queues the request asynchronously into `net.http_request_queue` and its background worker sends it *after the surrounding transaction commits* — so the saver's POST is never blocked, and a rolled-back dispute INSERT never notifies. The Vault-secret lookups (`project_url` / `service_role_key`) + the `WHERE EXISTS` guard make the trigger a clean no-op on an unseeded local stack (same as the cron) — so local E2E will not auto-fire `dispute-notify`; its Deno test invokes the function directly (the `sms-worker` test precedent).

### Why the Edge Function, not a pure DB trigger

The four outputs need an HTTP client (Resend), the Supabase Realtime client, and structured per-output error handling — all natural in a Deno Edge Function, awkward in plpgsql. The trigger's only job is to *invoke* the function.

### `dispute_ack` SMS — already 90% built

`format_sms_body('dispute_ack', p_transaction_id)` exists and renders the body; `dispute_ack` is already an allowed `sms_queue.template_key` and a typed `sms-worker` key. The ONLY missing piece is the enqueue — `enqueue_dispute_ack` does the `vault_decrypt` phone resolution + the INSERT. `format_sms_body` looks up the newest `disputes.id` for the transaction, so the `disputes` row MUST exist first — guaranteed (the trigger is AFTER INSERT).

### `dispute_ack` ignores opt-out — deliberate

`enqueue_sms_on_transaction` gates on `members.sms_opt_out`. `enqueue_dispute_ack` deliberately does NOT: a dispute acknowledgment is a transactional response to the saver's own explicit action and carries the reference number they need to follow up — it is not an unsolicited notification (FR32's opt-out target). Documented here so a reviewer does not "fix" it.

### No new audit event

Story 10.1's `audit_disputes` AFTER INSERT trigger already hash-chains `dispute.flagged`. 10.2 emits NO audit event and does NOT touch `audit_append_external`'s allowlist — a second `dispute.flagged` would fork the chain semantics. The epic AC's "logs a dispute.flagged audit event" is satisfied by 10.1.

### Email provider — Resend

No email infra exists. Resend is the pragmatic MVP choice: ESM/Deno-friendly, a plain REST API (`POST https://api.resend.com/emails`) callable with `fetch` — no SDK, consistent with the Termii client. The operator provisions `RESEND_API_KEY` + a verified sender domain + `FOUNDER_SUPPORT_EMAIL` as Edge-Function secrets. **This is a noted decision** — if the project prefers another provider, only `email-client.ts` changes. Email is best-effort: an unset key → `skipped`, never a 500.

### Realtime — emit only (Q-ARCH6)

`architecture.md` Q-ARCH6: Supabase Realtime is sanctioned ONLY for dispute notifications (everything else polls). 10.2 emits a `broadcast` on `disputes:{collector_id}` from the Edge Function's service-role supabase-js client. The payload is ids only — no saver PII. The client subscription is Story 10.3.

### Anti-patterns to avoid

- **DO NOT** re-emit `dispute.flagged` / touch `audit_append_external` — Story 10.1 owns the audit event.
- **DO NOT** add an npm/Deno SDK for email — `fetch` to Resend's REST API.
- **DO NOT** make any output fatal — all four are independent best-effort; the function returns 200 unless the *input* is unparseable.
- **DO NOT** gate the `dispute_ack` SMS on `sms_opt_out`.
- **DO NOT** build the client-side Realtime subscription / the in-app toast / the member-profile banner — those are Story 10.3.
- **DO NOT** log saver PII (phone, name, dispute free-text).
- **DO NOT** modify Story 10.1's `flag_transaction_dispute` or the receipt-URL Worker.
- **DO NOT** `npm run db:reset`; `nvm use 22` before `npm` anything; `psql`-smoke-test the migration.

### Project structure notes

**New files:**
- `supabase/migrations/<timestamp>_dispute_notify_trigger_and_enqueue.sql`
- `supabase/functions/dispute-notify/index.ts` (+ `index.test.ts`)
- `supabase/functions/_shared/email-client.ts`
- `supabase/functions/_shared/enqueue-dispute-ack.contract.test.ts`

**Modified files:**
- `supabase/config.toml` — `[edge_runtime.secrets]` entries.
- `.env.example` — `RESEND_API_KEY`.
- `scripts/run-edge-tests.sh` — register the 2 new test files.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

### Testing standards

- Deno test runner; the `re-auth/index.test.ts` (importable `handler`) pattern for `dispute-notify`. Mock the Resend `fetch` with `installFetchRecorder` (`_shared/test-fixtures.ts`). `_shared/*.contract.test.ts` for `enqueue_dispute_ack`. `envOrSkip()` so the suite skips cleanly without Supabase env.
- Migration: `psql` smoke test (`enqueue_dispute_ack` enqueues a rendered `sms_queue` row; opt-out ignored).
- No app-code (`src/`) change → vitest/Playwright are no-regression checks only.

### Definition-of-done checklist

- All 20 ACs satisfied + all 7 tasks ticked.
- A `disputes` INSERT fires the trigger → `dispute-notify` → the saver `dispute_ack` SMS is enqueued, the founder email is sent (or cleanly skipped), the collector Realtime `broadcast` is emitted, the push stub is logged.
- No new audit event; no `audit_append_external` change; no new npm dependency; Story 10.1 untouched.
- All gates green on Node 22; migration `psql`-smoke-tested; `test:edge` incl. the new tests; full Playwright suite no-regression.
- Story status `review`; sprint-status updated; touched line updated.

## References

- **Epic spec:** `epics.md` lines 1341-1354 (Story 10.2 BDD), line 183 (AR12).
- **PRD:** `prd.md` — FR33b (immediate collector in-app + founder email/push notification; "within minutes"), line 384 ("MVP: no push"), lines 388-390 (push is Growth).
- **Architecture:** `architecture.md` — Q-ARCH6 (Realtime sanctioned ONLY for dispute notifications; everything else polls), AR12 (`dispute-notify` routes collector + founder), line 363 (communication services — Termii via HTTP, no SDK).
- **Existing code:** `supabase/functions/sms-worker/index.ts` (the `pg_net`-invoked, service-role-checked Edge Function precedent), `supabase/functions/re-auth/index.ts` (the importable-`handler` + guarded-`Deno.serve` variant), `supabase/functions/_shared/{auth-check,rfc7807,termii-client,test-fixtures}.ts`, `supabase/migrations/20260428000002_schedule_sms_worker.sql` (the `pg_net` + Vault-secrets invocation), `20260429000002_format_sms_body.sql` + `20260515000001_format_sms_body_settlement_content.sql` (`format_sms_body` incl. the `dispute_ack` branch), `20260513000002_enqueue_resend_transaction.sql` (the enqueue-RPC pattern), `20260427000003_extend_sms_queue_for_dispatch.sql` (the `sms_queue` `template_key` CHECK incl. `dispute_ack`), `20260516101216_dispute-flag-audit-and-rpc.sql` (Story 10.1 — `flag_transaction_dispute` + the `audit_disputes` trigger), `supabase/config.toml` (`[edge_runtime.secrets]` + `[functions.sms-inbound]`), `.env.example` (`FOUNDER_SUPPORT_EMAIL` already declared).
- **CLAUDE.md:** `db:migrate` not `db:reset`; no new deps for trivial needs; cite sources.
- **Memory:** `feedback_migration_rpc_smoke_test.md`, `feedback_npm_lockfile_node_version.md`, `feedback_run_coverage_locally.md`, `feedback_push_then_ci_failure.md`, `project_supabase_rpc_binding.md`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- No blocking issues. The migration applied first-try (`db:migrate`); the `enqueue_dispute_ack` RPC + the `dispute_notify_after_insert` trigger psql-smoke-tested green (`(1,NULL)` enqueue, `(0,not_found)`, the trigger present). The 8 Deno tests (`dispute-notify/index.test.ts` ×6 + `enqueue-dispute-ack.contract.test.ts` ×2) passed first-try — the happy path logged `sms:"queued"`, `email:"skipped"` (no `RESEND_*` in the test runner), `realtime:"sent"` (the local Realtime broadcast even succeeded).

### Completion Notes List

- **Migration `20260516203656`** — (a) `enqueue_dispute_ack(p_transaction_id)` SECURITY DEFINER RPC: resolves `collector_id` + the vault-decrypted phone from the transaction (NOT `auth.uid()` — the service-role caller has no JWT), renders the body via `format_sms_body('dispute_ack', …)`, INSERTs a `dispute_ack` `sms_queue` row; returns `(1,NULL)` / `(0,not_found)` / `(0,no_phone)`; service_role-only. Deliberately does NOT gate on `sms_opt_out` (a transactional response to the saver's own action). (b) `dispute_notify_trigger()` + the `dispute_notify_after_insert` AFTER INSERT trigger on `public.disputes` — `pg_net.http_post` to `{project_url}/functions/v1/dispute-notify`, Vault-secret lookups + the `WHERE EXISTS` guard (no-ops on an unseeded stack). The trigger appends `/functions/v1/dispute-notify` to the `project_url` Vault secret (treated as the base URL).
- **`dispute-notify/index.ts`** — the `export async function handler` + guarded `Deno.serve` variant (unit-testable). Service-role-asserted (`isServiceRole`, the `sms-worker` constant-time pattern). Parses `{dispute_id, transaction_id, collector_id}`; resolves the dispute row (also the existence check — unknown id → all `skipped`, 200); runs 4 independent best-effort outputs: (1) `enqueue_dispute_ack` RPC; (2) the founder email via `_shared/email-client.ts`; (3) a Realtime `broadcast` on `disputes:{collector_id}` (subscribe→send→remove, 5 s timeout); (4) a logged push stub. Returns `200 {ok, outputs:{sms,email,realtime,push}}`; only an unparseable input → RFC-7807 400. Never logs saver PII.
- **`_shared/email-client.ts`** — a minimal Resend `fetch` client (`POST https://api.resend.com/emails`), mirrors `termii-client.ts`. Best-effort: unset `RESEND_API_KEY`/`RESEND_FROM` → `skipped`; non-2xx/network → `failed`; never throws.
- **AC-vs-reality note** — the spec AC #2 said a non-service-role caller → `401`; the established `auth_service_role_required` problem (shared with `sms-worker`) is HTTP **403**. The implementation + test use `403` (consistent with the codebase). No behavioural concern — both are "denied".
- **No new audit event / no `audit_append_external` change** — Story 10.1's `audit_disputes` trigger already emits `dispute.flagged`. **No app-code (`src/`) change** — Story 10.2 is purely backend (Edge Function + migration + config). **No new npm dependency.**
- **Gates** (Node 22): typecheck ✓ · lint --max-warnings=0 ✓ · 962 vitest passed (no-regression — no `src/` change) ✓ · build ✓ · the 2 new Deno test files 8/8 green (the full `test:edge` also has the pre-existing `sms-inbound`/`sms-worker` failures — a LOCAL Edge-runtime Termii-secret gap, unrelated to 10.2) · full Playwright 41 passed (1 local-only failure: `flow-3-cycle-settlement` re-auth — fails identically on clean `main`; the `receipt-url-worker` dispute E2E passes — the new trigger correctly no-ops on the unseeded local stack).

### File List

**New:**
- `supabase/migrations/20260516203656_dispute-notify-trigger-and-enqueue.sql`
- `supabase/functions/dispute-notify/index.ts` (+ `index.test.ts`)
- `supabase/functions/_shared/email-client.ts`
- `supabase/functions/_shared/enqueue-dispute-ack.contract.test.ts`

**Modified:**
- `supabase/config.toml` — `[edge_runtime.secrets]`: `RESEND_API_KEY` / `RESEND_FROM` / `FOUNDER_SUPPORT_EMAIL`.
- `.env.example` — `RESEND_API_KEY` / `RESEND_FROM`.
- `scripts/run-edge-tests.sh` — registered the 2 new Deno test files.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-16 | Cross-LLM code review (claude-sonnet-4-6, 3-layer adversarial) — 0 decision + 6 patch + ~10 dismissed; all 6 patches applied. (1) HIGH: the trigger now uses a dedicated `dispute_notify_url` Vault secret (full URL, verbatim) instead of concatenating onto the `sms-worker`-shared `project_url`. (2) the `net.http_post` is EXCEPTION-isolated so a pg_net failure can't roll back the `disputes` INSERT. (3) `emitRealtime` inspects `channel.send()`'s result + `removeChannel` in `finally`. (4) the founder email includes the collector's phone, not just the UUID. (5) the 3 outputs run via `Promise.all`. (6) added the opt-out-ignored contract test + the unknown-dispute `realtime` assertion. A Blind Hunter "Critical" (`PERFORM … WHERE EXISTS` invalid) was a false positive — valid PL/pgSQL, confirmed by the Edge Case Hunter + `db:migrate`. Gates re-run green: typecheck / lint / 962 vitest / 9 Deno tests. | Dev agent (claude-opus-4-7[1m]) |
| 2026-05-16 | Story 10.2 implemented via bmad-dev-story on `feat/10-2-dispute-notify-edge-function` — 7 tasks / 20 ACs. Migration `20260516203656`: the `enqueue_dispute_ack` SECURITY DEFINER RPC + the `dispute_notify_after_insert` `pg_net` trigger. New `dispute-notify` Edge Function (4 best-effort outputs: SMS-enqueue / Resend founder email / Realtime broadcast / push stub) + `_shared/email-client.ts`. `config.toml` + `.env.example` gain the Resend/founder-email secrets. NO `src/` change, NO new audit event, NO new npm dependency. Gates green: typecheck / lint / 962 vitest (no-regression) / build / 8 new Deno tests / Playwright 41 passed (1 local-only `flow-3` failure). | Dev agent (claude-opus-4-7[1m]) |
| 2026-05-16 | Story 10.2 drafted via bmad-create-story — SECOND story of Epic 10 (Saver Dispute Flow & Data Rights). The `dispute-notify` Edge Function fans a flagged dispute out to four parties: the saver gets a `dispute_ack` SMS (a new `enqueue_dispute_ack` RPC → `sms_queue` → the existing `sms-worker`), the founder gets a Resend email, the collector gets a Supabase Realtime `broadcast` (emit-only — the client subscription is 10.3), and a push no-op stub is logged (real push is Growth). One migration: an `AFTER INSERT ON disputes` `pg_net` trigger that invokes the function + the `enqueue_dispute_ack` SECURITY DEFINER RPC. Each output is independent best-effort. NO new audit event (Story 10.1's `audit_disputes` trigger already emits `dispute.flagged`); NO `audit_append_external` change; NO new npm dependency (Resend via `fetch`). Email + `FOUNDER_SUPPORT_EMAIL`/`RESEND_API_KEY` secrets are newly introduced. 20 ACs / 7 tasks. | Spec author (claude-opus-4-7[1m]) |
