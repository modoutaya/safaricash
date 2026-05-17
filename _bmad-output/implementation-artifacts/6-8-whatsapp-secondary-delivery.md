# Story 6.8: WhatsApp Business secondary delivery

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **saver with a smartphone**,
I want **to receive my SafariCash receipts via WhatsApp if I've opted in**,
so that **the receipts land in my preferred messaging channel — without breaking SMS for everyone else (FR29).**

> **The LAST open story of Epic 6 (Collector Communication & SMS).** Epic 6 built the full SMS-receipt pipeline (the `enqueue_sms_on_transaction` trigger → `sms_queue` → the `sms-worker` Edge Function → Termii). Epics 7–10 shipped on top of it. Story 6.8 adds **WhatsApp as a secondary delivery channel** alongside SMS — provisioning-dependent and opt-in, with a **graceful no-op when WhatsApp is not provisioned**.
>
> **The shape of this story — read carefully:**
> - WhatsApp Business provisioning is a **Growth-phase** concern (architecture.md:86 — "deferred to Growth"). Story 6.8 does NOT provision a WhatsApp account and does NOT build a saver-facing opt-in UI. It builds the **delivery plumbing** so that the moment WhatsApp *is* provisioned (a single env var) and a saver *is* opted in (`members.whatsapp_opt_in = true`), receipts fan out to WhatsApp too — and until then, nothing changes.
> - At MVP `members.whatsapp_opt_in` defaults `false` and there is no surface to flip it, so the live behaviour after this story is **byte-identical to today** (one SMS row per receipt). The story's job is correctness of the dormant path + the not-provisioned graceful no-op.
>
> **What 6.8 ships:**
> 1. **One migration** — `members.whatsapp_opt_in` (+ `whatsapp_opt_in_at`); a `sms_queue.channel` column (`'sms'` | `'whatsapp'`, default `'sms'`); the `enqueue_sms_on_transaction` trigger enqueues a second `channel='whatsapp'` row when the saver is opted in; `claim_sms_queue_batch` returns `channel`; `set_member_sms_opt_out`'s queued-SMS cancellation is scoped to `channel='sms'`.
> 2. **The Termii client** (`_shared/termii-client.ts`) — a `'whatsapp'` channel.
> 3. **The `sms-worker`** — routes a claimed row by `channel`: `'sms'` unchanged; `'whatsapp'` → a Termii WhatsApp send when provisioned, a silent `abandoned` when not.
> 4. **`config.toml`** — the `TERMII_WHATSAPP_SENDER_ID` secret (its presence IS the "provisioned" signal).
>
> **Why a second `sms_queue` row (not a second send on one row):** the BDD says "the WhatsApp delivery status is recorded **separately** in `sms_queue`". A WhatsApp delivery has its own lifecycle — it can succeed while SMS fails, or vice versa — so it gets its own row with its own `status`. `sms_queue` already allows multiple rows per `transaction_id` (no unique constraint — `enqueue_resend_*` and `enqueue_dispute_ack` already do this); the new `channel` column is the discriminator.
>
> **Why the WhatsApp row is enqueued by the trigger but gated by the worker:** the trigger (Postgres) can check `members.whatsapp_opt_in` but CANNOT see the Edge-runtime env var that signals provisioning. So the trigger enqueues a `whatsapp` row whenever the saver is opted in; the **worker** is the provisioning gate — it claims the row, checks `TERMII_WHATSAPP_SENDER_ID`, and either sends or silently abandons.
>
> **Code-reuse map (DO NOT re-invent):**
> - **The enqueue trigger** — `enqueue_sms_on_transaction()` (current: `supabase/migrations/20260501000002_enqueue_sms_optout_check.sql` — verify by `grep`). It already builds the body via `format_sms_body`, gates on `members.sms_opt_out`, and skips phone-less savers. The WhatsApp INSERT is a sibling of the existing SMS INSERT inside the same trigger.
> - **The Termii client** — `supabase/functions/_shared/termii-client.ts`: `sendSmsNoRetry` already passes a `channel` field through to the Termii v3 API body (`"generic"` | `"dnd"` today). Termii v3 supports `channel: "whatsapp"`; add it to the type union + use `TERMII_WHATSAPP_SENDER_ID` as the `from`.
> - **The worker** — `supabase/functions/sms-worker/index.ts`: `processRow` already has the full sent/failed/retry/abandoned status machine. The `channel='whatsapp'` path reuses it; only the not-provisioned branch is new.
> - **The claim RPC** — `claim_sms_queue_batch` (`supabase/migrations/20260428000003_sms_worker_rpcs.sql`): re-derive to add `channel` to the `RETURNS TABLE`.
> - **The opt-in column pattern** — `members.sms_opt_out` / `sms_opt_out_at` (`supabase/migrations/20260501000001_add_sms_opt_out_to_members.sql`). Mirror it for `whatsapp_opt_in` / `whatsapp_opt_in_at`.
> - **The provisioning pattern** — `TERMII_API_KEY` / `TERMII_SENDER_ID` read via `Deno.env.get(...)` in `termii-client.ts`; `config.toml [edge_runtime.secrets]` has `TERMII_INBOUND_SECRET` / `RESEND_API_KEY`. Mirror it for `TERMII_WHATSAPP_SENDER_ID`.
>
> **What Story 6.8 does NOT ship:**
> - WhatsApp Business account provisioning itself (Growth).
> - A saver- or collector-facing opt-in UI for `whatsapp_opt_in` (Growth — there is no point until provisioning exists). No `src/` (React app) change.
> - A WhatsApp sibling for `dispute_ack` / `resend` / `opt_out_confirmation` — only **receipt dispatch** (`enqueue_sms_on_transaction`: contribution / rattrapage / advance / **settlement**) fans out to WhatsApp. The other enqueue functions stay SMS-only (they inherit `channel = 'sms'` via the column default).
> - A WhatsApp-specific message body or `template_key` — the WhatsApp row reuses the SMS body + `template_key`; `channel` is the discriminator.
> - New `whatsapp.*` audit event types — the worker reuses `sms.sent` / `sms.failed` / `sms.abandoned`, with `channel` in the payload.
> - A new npm dependency.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** trace to the `epics.md:1079-1086` BDD; the rest are spec-derived constraints.

### The migration — schema

1. **`members.whatsapp_opt_in`.** A new migration `supabase/migrations/<timestamp>_whatsapp-secondary-delivery.sql` (create via `npm run db:migrate:new whatsapp-secondary-delivery`) adds `whatsapp_opt_in boolean NOT NULL DEFAULT false` and `whatsapp_opt_in_at timestamptz NULL` to `public.members` (mirroring the `sms_opt_out` / `sms_opt_out_at` columns). `false` = not opted in.

2. **`sms_queue.channel`.** The migration adds `channel text NOT NULL DEFAULT 'sms'` to `public.sms_queue` with `CHECK (channel IN ('sms', 'whatsapp'))`. The `DEFAULT 'sms'` backfills every existing row and keeps every existing `INSERT` site (`enqueue_resend_*`, `enqueue_dispute_ack`, the Story 10.5 `opt_out_confirmation` INSERT) unchanged — they continue to produce `channel='sms'` rows with no edit.

### The migration — enqueue + claim + opt-out

3. **`enqueue_sms_on_transaction` enqueues a WhatsApp sibling.** The migration `CREATE OR REPLACE`s `public.enqueue_sms_on_transaction()` **rebased on its current body** (`20260501000002` — verify the latest via `grep`), preserving everything (the kind filter `contribution`/`rattrapage`/`advance`, the `format_sms_body` body, the phone-less skip, the `members.sms_opt_out` gate on the SMS row). It adds — after the existing SMS `INSERT` — a **second `INSERT INTO sms_queue` with `channel = 'whatsapp'`** when `members.whatsapp_opt_in = true` and the saver has a phone. The WhatsApp row carries the SAME `transaction_id`, `recipient_phone`, `body`, `template_key`, `status='queued'`, `retry_count=0` as the SMS row.

4. **SMS and WhatsApp gating are independent.** The SMS `INSERT` stays gated on `NOT sms_opt_out`; the WhatsApp `INSERT` is gated on `whatsapp_opt_in`. A saver opted **out** of SMS but **in** to WhatsApp gets ONLY the `whatsapp` row; a saver opted into both gets both; the default saver (`whatsapp_opt_in=false`) gets only the `sms` row. `whatsapp_opt_in` is its own affirmative consent — it does NOT depend on `sms_opt_out`.

5. **`claim_sms_queue_batch` returns `channel`.** The migration re-derives `public.claim_sms_queue_batch` (`DROP`+`CREATE` if the `RETURNS TABLE` shape changes — verify) from its current definition (`20260428000003`), adding `channel` to the returned columns so the worker can route. All other claim behaviour (`FOR UPDATE SKIP LOCKED`, the TTL claim, `last_attempt_at`) preserved. Re-grant `EXECUTE`.

6. **`set_member_sms_opt_out`'s cancellation is scoped to `channel='sms'`.** The migration `CREATE OR REPLACE`s `public.set_member_sms_opt_out` **rebased on its current body** (`20260517001214` — Story 10.5 is the latest to touch it; preserve the `opt_out_confirmation` enqueue + everything else). The queued-SMS cancellation `UPDATE sms_queue … WHERE … status='queued'` gains `AND channel='sms'` — an SMS opt-out must NOT abandon a queued WhatsApp row (WhatsApp delivery is governed by `whatsapp_opt_in`, a separate consent).

### The Termii client + the "provisioned" signal

7. **The Termii client supports a `'whatsapp'` channel.** `supabase/functions/_shared/termii-client.ts` — the `channel` type gains `'whatsapp'`. A WhatsApp send POSTs to the Termii v3 send endpoint with `channel: 'whatsapp'` and `from = TERMII_WHATSAPP_SENDER_ID` (WhatsApp Business requires an approved sender distinct from the SMS sender ID). The request/success/failure shape otherwise matches the existing SMS path.

8. **"Provisioned" = `TERMII_WHATSAPP_SENDER_ID` is set.** The provisioning signal is `Deno.env.get("TERMII_WHATSAPP_SENDER_ID")` being present and non-empty (mirrors the `TERMII_SENDER_ID` / `TERMII_API_KEY` pattern). `supabase/config.toml` `[edge_runtime.secrets]` gains `TERMII_WHATSAPP_SENDER_ID = "env(TERMII_WHATSAPP_SENDER_ID)"`.

### The worker — channel routing

9. **`sms-worker` routes by `channel`.** `supabase/functions/sms-worker/index.ts` — the `ClaimedRow` type gains `channel: 'sms' | 'whatsapp'`. `processRow` branches on it.

10. **A `channel='sms'` row — unchanged.** Behaviour byte-identical to today: Termii SMS send, the existing `sent` / `failed` / retry / `abandoned`-at-24h status machine + the `sms.*` audit events.

11. **A `channel='whatsapp'` row, WhatsApp PROVISIONED.** **Given** `TERMII_WHATSAPP_SENDER_ID` is set, the worker sends via the Termii WhatsApp channel and applies the SAME status machine as SMS (`sent` on 2xx; `failed` on 4xx; retry with backoff on 5xx/timeout; `abandoned` on a 5xx older than 24h). The `sms.sent` / `sms.failed` / `sms.abandoned` audit events are reused, with `channel: 'whatsapp'` included in the audit payload.

12. **A `channel='whatsapp'` row, WhatsApp NOT provisioned.** **Given** `TERMII_WHATSAPP_SENDER_ID` is unset/empty, **When** the worker claims that row, **Then** it marks the row `status='abandoned'`, `abandoned_at=now()` and stops — **NO Termii call, NO audit event, NO retry, NO error log** (an `info`-level structured log is acceptable; an `error` log is not). This is the BDD's "no failure, no retry, no error logged for the missing WhatsApp".

### Behaviour (BDD)

13. **Given** WhatsApp is provisioned **And** a saver has `whatsapp_opt_in = true`, **When** a receipt is dispatched (a `contribution`/`rattrapage`/`advance`/`settlement` transaction is committed — every kind `enqueue_sms_on_transaction` handles; the cycle-close settlement receipt follows the saver's channel preference too), **Then** the message is sent via WhatsApp **in addition to** SMS — two `sms_queue` rows for the transaction (`channel='sms'` + `channel='whatsapp'`), each independently sent by the worker.

14. **And** the WhatsApp delivery status is recorded **separately** — the `channel='whatsapp'` row carries its own `status` (`queued`→`sent`/`failed`/`abandoned`), independent of the `sms` row's status.

15. **Given** WhatsApp is not yet provisioned, **When** a receipt is dispatched, **Then** only SMS is effectively delivered: the `sms` row sends normally; a `whatsapp` row (if the saver is opted in) is silently `abandoned` by the worker; SMS delivery is in no way affected; nothing errors.

16. **No-regression / dormant-by-default.** With `whatsapp_opt_in = false` (the MVP default for every saver — there is no opt-in UI) the trigger enqueues exactly ONE `sms` row, exactly as today. The full existing SMS pipeline + every Epic 6–10 behaviour is unchanged.

### Scope + tests + gates

17. **Receipt dispatch only.** Only `enqueue_sms_on_transaction` gets the WhatsApp sibling INSERT. `enqueue_dispute_ack`, `enqueue_resend_history`, `enqueue_resend_transaction`, and the `opt_out_confirmation` INSERT stay SMS-only (they inherit `channel='sms'` from the column default — verify no edit is needed).

18. **No `src/` change, no new dependency.** No React-app change (no opt-in UI — Growth). No `package.json` change. All new code is in `supabase/`.

19. **Deno contract tests.** Cover: (a) the enqueue trigger — a `whatsapp_opt_in=true` member's transaction yields TWO `sms_queue` rows (`channel` `'sms'` + `'whatsapp'`), a `whatsapp_opt_in=false` member yields ONE (`channel='sms'`); the SMS-opted-out + WhatsApp-opted-in member yields only the `whatsapp` row; (b) the worker — a `channel='whatsapp'` row with `TERMII_WHATSAPP_SENDER_ID` unset → `abandoned`, no audit; with it set → a Termii WhatsApp call (a 4xx with the mock key → `failed`, mirroring the SMS test pattern); (c) `claim_sms_queue_batch` returns `channel`; (d) `set_member_sms_opt_out` abandons a `channel='sms'` queued row but NOT a `channel='whatsapp'` queued row. Extend the existing `sms-dispatch-trigger.contract.test.ts` / `sms-worker/index.test.ts` / `set-member-sms-opt-out.contract.test.ts`; register any new test file in `scripts/run-edge-tests.sh`.

20. **Migration smoke-tested.** Applied with `npm run db:migrate` (NEVER `db:reset`) and `psql`-smoke-tested: a `whatsapp_opt_in` member's transaction → 2 `sms_queue` rows with the right `channel`s; a default member → 1; `claim_sms_queue_batch` returns `channel`; `set_member_sms_opt_out` leaves a `channel='whatsapp'` queued row untouched; the rebased `enqueue_sms_on_transaction` still enqueues a normal SMS row for a default member (no-regression check).

21. **All gates green** on Node 22 (`nvm use 22`): `typecheck`, `lint`, `test` (vitest — no `src/` change, confirm no regression), `build`, and `test:edge` for the new/extended Deno tests (the pre-existing local `sms-inbound` / `sms-worker` Termii-secret failures are unrelated and expected). No Playwright (no UI surface).

## Tasks / Subtasks

- [x] **Task 1 — Migration: the two columns** (AC: #1, #2)
  - [x] `npm run db:migrate:new whatsapp-secondary-delivery`.
  - [x] `alter table public.members add column whatsapp_opt_in boolean not null default false, add column whatsapp_opt_in_at timestamptz null;` + column comments.
  - [x] `alter table public.sms_queue add column channel text not null default 'sms';` + a `CHECK (channel in ('sms','whatsapp'))` constraint (use `NOT VALID` + a separate `VALIDATE` — the project pattern).
- [x] **Task 2 — Migration: `enqueue_sms_on_transaction`** (AC: #3, #4, #16, #17)
  - [x] `grep` for the latest `enqueue_sms_on_transaction` definition; `CREATE OR REPLACE` from that body.
  - [x] After the existing SMS `INSERT`, add the `channel='whatsapp'` sibling `INSERT` gated on `members.whatsapp_opt_in = true` + a phone present. Keep the SMS `INSERT` gated on `NOT sms_opt_out`.
- [x] **Task 3 — Migration: `claim_sms_queue_batch` + `set_member_sms_opt_out`** (AC: #5, #6)
  - [x] Re-derive `claim_sms_queue_batch` to return `channel`; re-grant `EXECUTE`.
  - [x] `CREATE OR REPLACE set_member_sms_opt_out` rebased on `20260517001214`; add `AND channel='sms'` to the queued-row cancellation `UPDATE`.
- [x] **Task 4 — Apply + smoke-test the migration** (AC: #20)
  - [x] `nvm use 22 && npm run db:migrate`; `psql`-smoke-test per AC #20.
- [x] **Task 5 — The Termii client + config** (AC: #7, #8)
  - [x] `_shared/termii-client.ts`: `channel` type + `'whatsapp'`; the WhatsApp send uses `channel:'whatsapp'` + `from = Deno.env.get("TERMII_WHATSAPP_SENDER_ID")`.
  - [x] `supabase/config.toml`: add `TERMII_WHATSAPP_SENDER_ID = "env(TERMII_WHATSAPP_SENDER_ID)"` to `[edge_runtime.secrets]`.
- [x] **Task 6 — The `sms-worker` channel routing** (AC: #9, #10, #11)
  - [x] `ClaimedRow` gains `channel`. `processRow` branches: `'sms'` → the existing path; `'whatsapp'` → if `TERMII_WHATSAPP_SENDER_ID` unset → `abandoned` (no audit, `info` log); else → the Termii WhatsApp send + the existing status machine, `channel` in the audit payload.
- [x] **Task 7 — Tests + gates** (AC: #19, #21)
  - [x] Extend the Deno contract tests (AC #19); register any new file in `scripts/run-edge-tests.sh`.
  - [x] Run all gates on Node 22 (AC #21); fill the Dev Agent Record + Change Log.

## Dev Notes

### The dormant path — this story is mostly "build it correctly, ship it quiet"

`whatsapp_opt_in` defaults `false` and Story 6.8 builds **no UI to flip it**, and `TERMII_WHATSAPP_SENDER_ID` is **not set** in any environment. So after this story merges, the *observable* behaviour is unchanged: every receipt produces exactly one `channel='sms'` row, sent exactly as before. The value of the story is that the plumbing is **correct and ready** — when Growth provisions WhatsApp Business (one env var) and adds an opt-in surface (a later story), receipts fan out to WhatsApp with zero further backend work. AC #16 (no-regression) is therefore the single most important AC: the rebased `enqueue_sms_on_transaction` MUST behave identically for the default saver.

### Why the WhatsApp row is enqueued unconditionally-on-opt-in (not on provisioning)

The trigger runs in Postgres; it can read `members.whatsapp_opt_in` but it CANNOT read `Deno.env`. The provisioning signal (`TERMII_WHATSAPP_SENDER_ID`) lives only in the Edge runtime. So the trigger enqueues a `whatsapp` row for every opted-in saver, and the **worker** is the provisioning gate. When WhatsApp is unprovisioned, those rows are claimed and immediately `abandoned` (AC #12) — a tiny amount of dead-row churn, but it keeps the provisioning decision in one place (the worker) and the trigger simple. In practice, since no saver is opted in at MVP, zero `whatsapp` rows are produced anyway.

### `abandoned`, not a new `skipped` status

The not-provisioned `whatsapp` row needs a terminal, non-error disposition. The `sms_queue_status_enum` has `queued / sent / delivered / failed / abandoned` — no `skipped`. Adding an enum value is invasive (`ALTER TYPE`) and unnecessary: `abandoned` already means "terminal, not delivered, not a delivery failure to alarm on". Reuse it — but the not-provisioned path must NOT emit the `sms.abandoned` audit event the 24h-old-5xx path emits (the BDD: "no error logged"). A bare `UPDATE … SET status='abandoned', abandoned_at=now()` with an `info` log and no `audit_append_external` call.

### The rebase discipline — `set_member_sms_opt_out` baseline is Story 10.5

`set_member_sms_opt_out` was `CREATE OR REPLACE`d by Story 10.5 (`20260517001214`) to add the `opt_out_confirmation` enqueue. Rebase on **that** body — not `20260501000004`. Stories 9.3 / 10.1 each shipped a bug from rebasing a shared function on a stale baseline; the psql smoke test (Task 4) must confirm `set_member_sms_opt_out` still enqueues the `opt_out_confirmation` SMS for a `p_via='receipt_url'` opt-out after this rebase. Same discipline for `enqueue_sms_on_transaction` — `grep` for its latest definition before rebasing.

### Audit events — reuse `sms.*`, do not invent `whatsapp.*`

The worker emits `sms.sent` / `sms.failed` / `sms.abandoned` via `audit_append_external`, which has an allowlist (`sms-worker-audit-allowlist.contract.test.ts`). A `whatsapp` row reuses those same event types — adding `channel: 'whatsapp'` to the audit payload `jsonb` is enough to distinguish them, and it avoids an allowlist migration. The BDD says the *status* is recorded separately in `sms_queue` (the row's `status` column) — it does not ask for separate audit event types.

### Termii WhatsApp specifics

Termii's v3 send API takes `channel: "whatsapp"` and requires an approved WhatsApp sender as `from` — distinct from the SMS sender ID, hence the dedicated `TERMII_WHATSAPP_SENDER_ID`. The `api_key` is the same `TERMII_API_KEY`. The `sms-worker` Deno tests do NOT mock Termii — they call the real API with a mock key and assert a 4xx → `failed`. The WhatsApp worker test follows the same pattern: with `TERMII_WHATSAPP_SENDER_ID` set to a dummy value, the mock-key Termii WhatsApp call returns 4xx → the `whatsapp` row → `failed`.

### Project Structure Notes

- New: one migration `supabase/migrations/<timestamp>_whatsapp-secondary-delivery.sql`.
- Modified by `CREATE OR REPLACE` / `DROP`+`CREATE`: `enqueue_sms_on_transaction`, `claim_sms_queue_batch`, `set_member_sms_opt_out`; `ALTER TABLE` on `members` + `sms_queue`.
- Modified: `supabase/functions/_shared/termii-client.ts`, `supabase/functions/sms-worker/index.ts`, `supabase/config.toml`; the relevant `_shared/*.contract.test.ts` + `sms-worker/index.test.ts`; `scripts/run-edge-tests.sh` if a new test file is added.
- No `src/` change, no `package.json` change, no Cloudflare Worker change.

### References

- **Epic spec:** `epics.md:1071-1086` (Story 6.8 BDD), `epics.md:290` (FR29 → Epic 6 — "WhatsApp secondary delivery, opt-in + provisioning dependent"), `epics.md:72` (FR29 statement).
- **PRD:** FR29 — "Every receipt is additionally delivered via WhatsApp if the saver has opted in and WhatsApp Business is provisioned."
- **Architecture:** `architecture.md:86` / `:363` (WhatsApp Business provisioning deferred to Growth), `:92` ("SMS primary, WhatsApp secondary — feature-phone savers are first-class"), `:1132` ("WhatsApp Business API — wired to SMS worker as secondary channel"). The architecture's "deferred to Growth" is about *provisioning*; Story 6.8 builds the provisioning-dependent *plumbing* with a graceful no-op, which is exactly what the epics.md BDD specifies.
- **Existing code — migrations:** `20260419000001_init_schema.sql` (`sms_queue` table + `sms_queue_status_enum`), `20260427000003_extend_sms_queue_for_dispatch.sql` (the `template_key`/`retry_count`/etc. columns), `20260501000001_add_sms_opt_out_to_members.sql` (the `sms_opt_out` column pattern to mirror), `20260501000002_enqueue_sms_optout_check.sql` (the current `enqueue_sms_on_transaction`), `20260428000003_sms_worker_rpcs.sql` (`claim_sms_queue_batch`), `20260517001214_optout-confirmation-and-anonymised-gate.sql` (the current `set_member_sms_opt_out` — the rebase baseline).
- **Existing code — Edge Functions:** `supabase/functions/_shared/termii-client.ts` (`sendSmsNoRetry`, the `channel` field, the `TERMII_*` env reads), `supabase/functions/sms-worker/index.ts` (`processRow`, `ClaimedRow`, the status machine), `supabase/functions/sms-worker/backoff.ts`, `supabase/config.toml` (`[edge_runtime.secrets]`).
- **Existing tests:** `supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts`, `supabase/functions/sms-worker/index.test.ts`, `supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts`, `_shared/sms-worker-audit-allowlist.contract.test.ts`, `_shared/test-fixtures.ts`.
- **Previous story:** `6-7-per-transaction-receipt-share.md` (Epic 6 conventions; it names Story 6.8 as the WhatsApp-delivery story); `10-5-saver-optout-action.md` (the latest `set_member_sms_opt_out` rebase).
- **CLAUDE.md:** `db:migrate` not `db:reset`; rebase shared functions on their latest definition; no new deps for trivial needs.
- **Memory:** `feedback_migration_rpc_smoke_test.md` (psql-smoke-test RPC migrations), `feedback_npm_lockfile_node_version.md` (Node 22), `project_views_after_columns.md` (the `sms_queue.channel` column is new — no decrypted view is involved here, but the same explicit-projection care applies to `claim_sms_queue_batch`'s `RETURNS TABLE`).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **`enqueue_sms_on_transaction` restructure — the `sms_opt_out` early-return was the trap.** The pre-6.8 trigger early-returned the WHOLE function on `members.sms_opt_out` — which would have skipped the WhatsApp INSERT too, breaking AC #4 (a SMS-opted-out + WhatsApp-opted-in saver must still get the WhatsApp row). The rebase reworks it: a single row read fetches phone + `sms_opt_out` + `whatsapp_opt_in`; the `sms_opt_out` check now gates ONLY the SMS `INSERT`; the two `INSERT`s are independent `if` blocks. Verified by the `tk10` contract test (SMS-out + WA-in → only the `whatsapp` row).
- **The worker is the provisioning gate, not the trigger.** A Postgres trigger cannot read `Deno.env`, so it enqueues a `whatsapp` row for every opted-in saver; the `sms-worker` checks `TERMII_WHATSAPP_SENDER_ID` and either sends or silently `abandon`s. Not-provisioned → `abandonRow(... "whatsapp_not_provisioned" ...)` — reuses the existing helper (an `info` log, no audit).
- **Edge-runtime hot-reload timing.** The first `test:edge` run after editing `sms-worker/index.ts` served stale code (the worker test #13 failed once); the subsequent run picked up the new code and passed. A full clean run shows test #13 green. CI starts a fresh edge runtime so this is local-only noise.
- **`node_modules` / `deno.lock` pollution** — the Deno runs repopulate `node_modules/.deno/` (breaks vitest) and rewrite `deno.lock`. Restored via `npm ci`; reverted `deno.lock` (Story 6.8 adds no Deno deps).

### Completion Notes List

- **Migration `20260517093323_whatsapp-secondary-delivery.sql`** — adds `members.whatsapp_opt_in` (+ `_at`); `sms_queue.channel` (`'sms'`/`'whatsapp'`, default `'sms'` — `NOT VALID` CHECK + `VALIDATE`); `CREATE OR REPLACE enqueue_sms_on_transaction()` (the `sms_opt_out` check gates only the SMS row; a `channel='whatsapp'` sibling `INSERT` when `whatsapp_opt_in`); `DROP`+`CREATE claim_sms_queue_batch` (+ the `channel` column in `RETURNS TABLE`); `CREATE OR REPLACE set_member_sms_opt_out` rebased on `20260517001214` (the queued-row cancellation scoped `AND channel='sms'`).
- **`_shared/termii-client.ts`** — `TermiiSendArgs.channel` gains `'whatsapp'`; a `whatsapp` send uses `from = TERMII_WHATSAPP_SENDER_ID` via the new `getWhatsappSenderId()`.
- **`sms-worker/index.ts`** — `ClaimedRow` gains `channel`; `whatsappProvisioned()` checks `TERMII_WHATSAPP_SENDER_ID`; `processRow` — a `channel='whatsapp'` row + not provisioned → `abandoned` (no Termii call, no audit, no retry); else the Termii send passes `channel`; the `sms.*` audit payloads carry `channel`.
- **`config.toml`** — `TERMII_WHATSAPP_SENDER_ID` registered in `[edge_runtime.secrets]`.
- **psql smoke test** (`begin`/`rollback`) — a default member's transaction → 1 `channel='sms'` row; a `whatsapp_opt_in` member → 2 rows (`sms` + `whatsapp`); a `sms_opt_out` + `whatsapp_opt_in` member → only the `whatsapp` row; `claim_sms_queue_batch` returns `channel`; `set_member_sms_opt_out` abandoned the `channel='sms'` queued row and left the `channel='whatsapp'` row `queued`.
- **Dormant by default** — `whatsapp_opt_in` defaults `false`, no opt-in UI, `TERMII_WHATSAPP_SENDER_ID` unset → every receipt produces exactly one `channel='sms'` row, exactly as before. No-regression confirmed (`tk8` test + 990 vitest unchanged).
- **Gates** (Node 22): typecheck ✓ · lint --max-warnings=0 ✓ · 990 vitest passed (no `src/` change — no regression) ✓ · build ✓ · `test:edge` — the 5 new Story 6.8 tests green within the full run (193 passed; the 8 failures are exclusively the pre-existing local `sms-inbound` Termii-inbound-secret gap — unrelated, CI-green). No Playwright (no UI surface).

### File List

**New:**
- `supabase/migrations/20260517093323_whatsapp-secondary-delivery.sql`

**Modified:**
- `supabase/functions/_shared/termii-client.ts` — the `'whatsapp'` channel + `getWhatsappSenderId()`.
- `supabase/functions/sms-worker/index.ts` — `ClaimedRow.channel`, `whatsappProvisioned()`, the channel routing in `processRow`, `channel` in the audit payloads.
- `supabase/config.toml` — the `TERMII_WHATSAPP_SENDER_ID` edge-runtime secret.
- `supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts` — 3 Story 6.8 enqueue tests.
- `supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts` — test 9 (the `channel='sms'`-scoped cancellation).
- `supabase/functions/sms-worker/index.test.ts` — test 13 (the not-provisioned `whatsapp` row → `abandoned`, no audit).
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-17 | Story 6.8 implemented via bmad-dev-story on `feat/6-8-whatsapp-secondary-delivery` — 7 tasks / 21 ACs; the LAST open story of Epic 6. ONE migration `20260517093323`: `members.whatsapp_opt_in` (+`_at`); `sms_queue.channel` (`sms`/`whatsapp`, default `sms`); `enqueue_sms_on_transaction` rebased — the `sms_opt_out` check gates only the SMS row, a `channel='whatsapp'` sibling `INSERT` fires on `whatsapp_opt_in` (independent consents); `claim_sms_queue_batch` `DROP`+`CREATE`d to return `channel`; `set_member_sms_opt_out` rebased on `20260517001214` with the queued-row cancellation scoped to `channel='sms'`. The Termii client gains a `whatsapp` channel; the `sms-worker` routes a claimed row by `channel` — provisioned (`TERMII_WHATSAPP_SENDER_ID` set) → Termii WhatsApp send; not provisioned → silent `abandoned` (no audit/retry/error). `config.toml` registers the secret. Dormant by default — `whatsapp_opt_in` false, no opt-in UI, no env → observable behaviour byte-identical to today. NO `src/` change, NO new dependency. psql-smoke-tested. Gates green: typecheck / lint / 990 vitest (no regression) / build / `test:edge` 5 new Story 6.8 tests green (the 8 failures are the pre-existing local `sms-inbound` Termii-secret gap). | Dev agent (claude-opus-4-7[1m]) |
| 2026-05-17 | Story 6.8 drafted via bmad-create-story — the LAST open story of Epic 6 (Collector Communication & SMS). WhatsApp Business secondary delivery (FR29): provisioning-dependent + opt-in, with a graceful no-op when WhatsApp is unprovisioned. ONE migration: `members.whatsapp_opt_in` (+ `_at`); a `sms_queue.channel` column (`sms`/`whatsapp`, default `sms`); `enqueue_sms_on_transaction` enqueues a second `channel='whatsapp'` row when the saver is opted in (SMS + WhatsApp gating independent — a SMS opt-out doesn't suppress WhatsApp); `claim_sms_queue_batch` returns `channel`; `set_member_sms_opt_out`'s queued-row cancellation scoped to `channel='sms'`. The Termii client gains a `whatsapp` channel; the `sms-worker` routes a claimed row by `channel` — `whatsapp` + provisioned (`TERMII_WHATSAPP_SENDER_ID` set) → Termii WhatsApp send; `whatsapp` + not provisioned → silent `abandoned` (no audit, no retry, no error). `config.toml` registers the secret. Dormant by default (`whatsapp_opt_in=false`, no opt-in UI, no provisioning) — observable behaviour byte-identical to today. NO `src/` change, NO new dependency, NO opt-in UI, NO WhatsApp sibling for dispute_ack/resend/opt_out_confirmation. 21 ACs / 7 tasks. | Spec author (claude-opus-4-7[1m]) |

## Review Findings

**Reviewed:** 2026-05-17 · `bmad-code-review` · 3-layer adversarial (Blind Hunter / Edge Case Hunter / Acceptance Auditor, sonnet-4-6) on the staged diff of `feat/6-8-whatsapp-secondary-delivery` (9 files, +817/−6).

**Verdict:** APPROVE WITH 1 DECISION + PATCHES. No Critical defects. The three function rebases (`enqueue_sms_on_transaction`, `claim_sms_queue_batch`, `set_member_sms_opt_out`) are confirmed byte-for-byte clean by the Edge Case Hunter — every prior behaviour preserved. 1 decision-needed, 3 patches (Low), 1 deferral, 6 dismissed.

### Decision needed (D1)

- [x] [Review][Decision] **D1 — Should a `kind='settlement'` transaction fan out to WhatsApp?** [`supabase/migrations/20260517093323_whatsapp-secondary-delivery.sql`]. The trigger's kind filter is `('contribution','rattrapage','advance','settlement')`; the `if v_whatsapp_opt_in` block has NO kind sub-filter, so a `settlement` transaction for a WhatsApp-opted-in saver enqueues a `channel='whatsapp'` row (the cycle-close receipt goes to WhatsApp too). The spec is internally inconsistent: AC #13's BDD enumerates `contribution`/`rattrapage`/`advance`, but scope-item #17 says "`enqueue_sms_on_transaction` gets the WhatsApp sibling" without excluding `settlement`. Functionally, sending the settlement receipt on WhatsApp is arguably *better* (consistent with the SMS settlement receipt — a saver opted into WhatsApp would expect their cycle-close receipt there too). **Keep** (settlement → WhatsApp; fix the spec wording) or **exclude** (add `new.kind <> 'settlement'` to the WhatsApp block; match AC #13's literal list)? Dormant either way until WhatsApp is provisioned (Growth).

### Patches to apply (P1–P3)

- [x] [Review][Patch] **P1 — scope the `first_receipt`/`subsequent_receipt` count to `channel='sms'` (Low)** [`supabase/migrations/20260517093323_whatsapp-secondary-delivery.sql`]. The template picker's `select count(*) from sms_queue …` has no channel filter, so it counts WhatsApp rows too. The `0 vs >0` boundary means there is no functional skew for realistic cases (Edge Hunter confirmed), but the count's intent is "has the saver received an *SMS* receipt" — add `AND sq.channel = 'sms'` so it is semantically exact (and removes a hypothetical edge: a WhatsApp-only saver who later re-enables SMS would otherwise get the short `subsequent_receipt` as their first SMS, skipping the STOP-consent line).
- [x] [Review][Patch] **P2 — add a `termii-client` unit test for the WhatsApp channel (Low)** [`supabase/functions/_shared/`]. AC #19(b) asks for coverage of the provisioned WhatsApp send. The full worker-level provisioned test is env-constrained (deferred — see below), but the WhatsApp-specific client wiring IS unit-testable in-process: a new test mocks `globalThis.fetch`, sets `TERMII_WHATSAPP_SENDER_ID`, calls `sendSmsNoRetry({ channel: "whatsapp", … })`, and asserts the Termii request body carries `channel: "whatsapp"` + `from = <TERMII_WHATSAPP_SENDER_ID>` (and that a non-whatsapp send uses the SMS sender). Register the new file in `scripts/run-edge-tests.sh`.
- [x] [Review][Patch] **P3 — add an explicit `claim_sms_queue_batch` returns-`channel` assertion (Low)** [`supabase/functions/sms-worker/index.test.ts` or a `_shared` contract test]. AC #19(c) asks for it. Worker test #13 covers it transitively (the row is abandoned ⟹ the worker read `channel='whatsapp'` from the claim), but add a direct assertion: seed a `channel='whatsapp'` queued row, call `claim_sms_queue_batch`, assert the returned row has `channel === 'whatsapp'`.

### Deferred (1)

- [x] [Review][Defer] **The full worker-level provisioned-WhatsApp E2E test** [`supabase/functions/sms-worker/index.test.ts`] — deferred. The `sms-worker` contract test POSTs to a separately-running edge-runtime process; the test process cannot inject `TERMII_WHATSAPP_SENDER_ID` into *that* process's env, so the "provisioned → Termii WhatsApp send → 4xx → failed" worker path cannot be exercised by the contract suite (the same structural limitation the existing suite documents for the Termii-success path). P2 covers the WhatsApp-specific client wiring at the unit level; the worker's post-send status machine is channel-agnostic — it is the exact same (already-tested) code as the SMS 4xx→failed path.

### Dismissed (6)

`abandonRow` emitting an `sms.abandoned` audit on the not-provisioned path (Blind Hunter, diff-only — the Edge Case Hunter confirmed `abandonRow` does NOT call `emitAudit`; the 24h-5xx path emits its audit via a separate inline block; test #13 asserts `auditCount === 0`); the SMS Termii channel "hardcoded to `'generic'` dropping `'dnd'`" (the prior call defaulted to `'generic'` — `'dnd'` was never passed by the worker; no behaviour change); `getWhatsappSenderId()` throwing and bypassing the abandon gate (unreachable — the worker gates on `whatsappProvisioned()` before the whatsapp send; the throw is intentional defence-in-depth); test #13 leaving an orphan `sms_queue` row (`cleanup` deletes `sms_queue` by `collector_id` first — no orphan); test #9 setup brittleness (the Blind Hunter itself concluded "no defect"; `seedMemberWithCycle` yields a non-opted-out member so both rows are queued); `'settlement'` in the kind allowlist of the rebased trigger (verified — the current `20260501000002`-line definition already carries `'settlement'` from Story 7.4; the rebase preserved it).

### Patch Resolution — 2026-05-17

**D1 resolved → A (keep).** A `kind='settlement'` transaction DOES fan out to WhatsApp — the cycle-close receipt follows the saver's channel preference, consistent with the settlement SMS. No code change; the spec wording (the story header + AC #13) was corrected to remove the contradiction.

All 3 patches (P1–P3) applied:

- **P1** — `enqueue_sms_on_transaction`: the `first_receipt`/`subsequent_receipt` count query is scoped `AND sq.channel = 'sms'` — the picker now decides on the saver's *SMS* history only.
- **P2** — new `supabase/functions/_shared/termii-client.test.ts` (registered in `run-edge-tests.sh`): mocks `globalThis.fetch` and asserts `channel='whatsapp'` → the Termii body carries `channel:'whatsapp'` + `from = TERMII_WHATSAPP_SENDER_ID`; `channel='generic'` → the SMS sender (never the WhatsApp sender).
- **P3** — `sms-worker/index.test.ts` test 14: seeds a `channel='whatsapp'` queued row, calls `claim_sms_queue_batch`, asserts every claimed row carries a valid `channel` (and the seeded row, if in the batch, is `'whatsapp'`).

The full worker-level provisioned-WhatsApp E2E stays deferred (env-constrained — the contract suite cannot inject `TERMII_WHATSAPP_SENDER_ID` into the separate worker process; P2 covers the WhatsApp-specific wiring at the unit level).

**Gates re-run (Node 22):** typecheck ✓ · lint --max-warnings=0 ✓ · 990 vitest passed ✓ · build ✓ · `test:edge` — the 8 Story 6.8 tests green (3 enqueue + opt-out-scoping + worker not-provisioned + claim-channel + 2 termii-client; 196 passed total; the 8 failures are exclusively the pre-existing local `sms-inbound` Termii-secret gap). The patched migration re-applied + re-smoke-tested. Story status → `done`.
