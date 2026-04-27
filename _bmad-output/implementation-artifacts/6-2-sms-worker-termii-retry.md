# Story 6.2: SMS worker with Termii + exponential backoff + status propagation

Status: ready-for-dev

## Story

As a **developer**,
I want **a scheduled SMS worker that drains `sms_queue`, calls Termii, records delivery status, and retries on failure with exponential backoff**,
so that **SMS delivery is reliable and the UI can expose progressive state (NFR-R4, NFR-P4).**

> **Predicate of this story.** Story 1.2 shipped the `sms_queue` table + the `sms_queue_status_enum` enum (`queued`, `sent`, `delivered`, `failed`, `abandoned`). Story 1.3 shipped the Termii client (`supabase/functions/_shared/termii-client.ts` — `sendSms()` with internal 3× retry intended for OTP fire-and-fail-fast). Story 4.3 shipped the AFTER INSERT `enqueue_sms_on_transaction` trigger that pushes a STUB-bodied row into the queue. Story 4.5 flipped `sms_queue.transaction_id` FK from `CASCADE` to `SET NULL` AND added `transactions.undone_at` (the soft-undo column). Story 6.1 extended the schema (`template_key`, `retry_count`, `next_retry_at`, `abandoned_at`), added the partial drain index `idx_sms_queue_drain_ready`, rewrote the trigger to populate `template_key`, and shipped `audit_append_external(p_event_type, p_entity_id, p_entity_table, p_payload)` (currently allowlists only `sms.queued`). Story 6.2 closes the loop end-to-end: ships the **scheduled worker Edge Function `/functions/v1/sms-worker`** that drains the queue, calls Termii, mutates row status with exponential-backoff retry on transient failure, abandons after 24 h, and audits every terminal state transition. **What Story 6.2 does NOT ship**: the actual SMS template copy (body remains the `'[STUB] Transaction enregistrée'` literal until Story 6.3 ships `format_sms_body(template_key, transaction_id)`); the receipt URL the body will eventually include (Story 6.4 ships the Cloudflare Worker); the `members.sms_opt_out` column the worker should additionally honour (Story 6.5 ships the column — Story 6.2 includes a placeholder check); the Termii **delivery-receipt webhook** that would advance rows from `sent` → `delivered` (deferred, see AC #14). It also does NOT ship a UI surface — the worker is backend-only.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 977-983; the rest are spec-derived constraints required for a flawless implementation.

1. **Edge Function `/functions/v1/sms-worker`** at `supabase/functions/sms-worker/index.ts`:
   - **Method:** `POST` only — any other method returns `405 Method Not Allowed` (RFC 7807 — the `method_not_allowed` problem key already lives in `_shared/rfc7807.ts` from Story 6.1; reuse).
   - **Auth:** Service-role bearer token only (architecture.md line 1043 — *"SMS worker (drain queue) | Edge Function `/functions/v1/sms-worker` (scheduled) | Service role"*). Reject any other JWT (including authenticated collector JWTs) with `403 RFC 7807` using a NEW problem key `auth_service_role_required` (status 403, type `${PROBLEM_BASE}/auth/service_role_required`, title "Service role required") — add it to `KNOWN_PROBLEMS` in `_shared/rfc7807.ts`. Reasoning: the worker drains rows belonging to ALL collectors; running it under a single collector's RLS context would constrain the drain to that collector's rows and silently starve every other collector's queue.
   - **Service-role assertion logic (simpler approach):** byte-compare the bearer token to `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`. Identity match → service role; anything else → `auth_service_role_required` 403. This avoids local JWT decoding entirely and is exact: the service role key is a fixed string the platform deploys to the function's env. Use a constant-time comparison helper to defend against timing oracles (`crypto.subtle` is overkill; a length check + char-by-char loop suffices given the 200+ char fixed length). **Do NOT** call `anonClient.auth.getUser(jwt)` for the service role — it returns 401 (the service role JWT has `aud='authenticated'` but `role='service_role'` and isn't a user-context token).
   - **Body:** JSON, all fields optional. Schema: `{ batch_size?: number, dry_run?: boolean }`. Defaults: `batch_size=10`, `dry_run=false`. Both Zod-validated; invalid → `400 RFC 7807 request_invalid`. `batch_size` MUST be in `[1, 100]` (CHECK at the schema level — bigger batches risk Termii rate-limit against a 30 s cadence; Supabase Edge Functions have a 60 s max wall-clock per invocation per architecture.md and architecture.md:1043). **`dry_run=true` mode**: drain the batch normally, log per-row decisions, but skip the Termii fetch AND skip the DB UPDATE/audit emission — returns `{ drained: n, sent: 0, ..., dry_run: true }` for ops/debugging.
   - **Logging:** structured JSON via `console.log`, NEVER plaintext phone or body. Per-row log includes: `queue_id`, `template_key`, `recipient_phone_hash` (16-hex SHA-256 prefix as in Story 6.1), `outcome` (`sent`/`scheduled_retry`/`abandoned`/`failed`/`skipped`), `retry_count`, `duration_ms`. Worker-level log on entry/exit includes: `level`, `event` (`sms_worker.drain_started`/`sms_worker.drain_completed`), `batch_size`, `rows_drained`, `rows_sent`, `rows_failed`, `rows_abandoned`, `rows_skipped`, `total_duration_ms`. Mirrors the Story 6.1 logging conventions; reuses the same `logJson()` helper shape.
   - **Errors:** RFC 7807 across the board. The HTTP-200 response from a successful drain returns `{ "drained": <int>, "sent": <int>, "scheduled_retry": <int>, "abandoned": <int>, "failed": <int>, "skipped": <int> }` for ops/observability.

2. **Drain query — atomic row claim with `FOR UPDATE SKIP LOCKED`.** The worker MUST NOT race itself when two scheduler ticks overlap (e.g., a 30 s drain that occasionally takes 35 s due to Termii latency would have the next tick fire while the previous is mid-drain). The drain query is:

   ```sql
   SELECT sq.id, sq.collector_id, sq.transaction_id, sq.recipient_phone, sq.body,
          sq.template_key, sq.retry_count
   FROM public.sms_queue sq
   LEFT JOIN public.transactions t ON t.id = sq.transaction_id
   WHERE sq.status = 'queued'
     AND sq.abandoned_at IS NULL
     AND (sq.next_retry_at IS NULL OR sq.next_retry_at <= now())
     AND (t.id IS NULL OR t.undone_at IS NULL)  -- Story 4.5 handshake: skip soft-undone transactions
   ORDER BY sq.next_retry_at NULLS FIRST, sq.created_at
   LIMIT $1
   FOR UPDATE OF sq SKIP LOCKED;
   ```

   The `LEFT JOIN` (not INNER) is intentional — Story 4.5 flipped the FK to `ON DELETE SET NULL`, so rows with `transaction_id IS NULL` (parent transaction was hard-deleted prior to Story 4.5's flip, or some future hard-delete path) MUST still be drainable. The `t.id IS NULL OR t.undone_at IS NULL` filter excludes soft-undone transactions but accepts orphaned rows (which will dispatch their stub body — acceptable; these are rare edge cases from pre-4.5 data).

   Wrap the drain in a `BEGIN; ... COMMIT;` so the row lock is held for the duration of the Termii call. **However** — holding the lock during a 5 s Termii network round-trip across `batch_size=10` rows means up to 50 s of held connection time. Mitigations:
   - The `FOR UPDATE SKIP LOCKED` ordering bounds concurrency: a second concurrent worker tick takes the next batch, not contention.
   - Use one transaction per row (see AC #4) — not one transaction wrapping the whole batch. Each row's lock is released as soon as that row's status update commits, freeing it for the next drainer if needed.

3. **Per-row processing loop.** For each row returned by the drain query, the worker MUST:
   1. **Open a NEW transaction** for the row (one tx per row, NOT one tx for the batch — keeps lock window per row to ~Termii latency, ≤ ~6 s).
   2. **Re-claim the row inside the new tx** with the same `WHERE status='queued' AND abandoned_at IS NULL AND id = $1 FOR UPDATE` filter (defends against race where between drain query and per-row processing another worker raced via a SQL-direct INSERT — extremely unlikely with the outer `SKIP LOCKED` but the defence is cheap).
   3. **Skip-to-next** if the per-row re-claim returns 0 rows (the row was already processed or abandoned by another worker).
   4. **Story 6.5 placeholder check** — `IF FALSE THEN ... skip ... END IF` block in the per-row processing, mirroring the trigger's placeholder slot. Comment marks the spot for Story 6.5's `members.sms_opt_out` wire-in. Document this is structural — Story 6.5 only flips the boolean expression.
   5. **Call Termii** via a NEW `sendSmsNoRetry(args)` function exported from `_shared/termii-client.ts` (see AC #5).
   6. **Update row status** based on the outcome (see AC #6/#7/#8/#9).
   7. **Emit audit event** for terminal state transitions (see AC #11).
   8. **Commit the per-row transaction.**

4. **Termii client extension — `sendSmsNoRetry`.** The existing `sendSms()` in `_shared/termii-client.ts` performs 3× internal retry (1 s/2 s/4 s) intended for OTP fire-and-fail-fast (Story 1.3). The worker MUST NOT layer its own retry on top of that — the worker is the system of record for the durable retry policy (10 s → 600 s with 24 h abandon). Approach:
   - Add a NEW exported function: `export async function sendSmsNoRetry(args: TermiiSendArgs): Promise<TermiiSendResult>`. Internally calls the existing `sendOnce()` helper (which is currently file-private — export it OR make `sendSmsNoRetry` a thin one-call wrapper that mirrors `sendOnce`'s logic without the retry loop).
   - Cleanest: export `sendOnce` AS `sendSmsNoRetry` directly (rename the export, keep the internal `sendOnce` as the implementation). Or simpler: keep `sendOnce` as-is and add `export const sendSmsNoRetry = sendOnce;` at module scope.
   - Story 1.3's existing `sendSms()` continues to exist for the OTP path with its 3× retry intact. **Do NOT remove or refactor `sendSms()`** — it serves a different use case (synchronous user-blocking flow where waiting 7 s is acceptable; the worker is async and budget-bound).
   - Document the contrast in the new function's JSDoc: *"Worker-grade single-shot. Caller is responsible for retry/backoff. For the OTP synchronous path, use `sendSms()` which retries 3× internally."*

5. **Worker outcome — Termii success.** Termii returns 200 with a `message_id`:
   - `UPDATE sms_queue SET status='sent', last_attempt_at=now() WHERE id = $1` — `delivered_at` stays NULL because Termii's "sent" is acknowledgement of dispatch, NOT delivery confirmation. **Architecture decision**: Story 6.2 uses `status='sent'` to mean *"successfully dispatched to Termii; awaiting delivery receipt"*. The `delivered_at` column is reserved for Story 6.X's eventual delivery-receipt webhook handler (out of scope here — see AC #14 deferral note).
   - `retry_count` is NOT incremented on success (it represents *retries that were necessary*, not *attempts made*).
   - `next_retry_at` MUST be cleared to NULL (defensive — the row should never be re-drained).
   - Emit `sms.sent` audit event with payload `{ template_key, recipient_phone_hash, message_id }` via `audit_append_external`.

6. **Worker outcome — Termii 4xx (client error / non-retryable).** Termii returns 4xx (bad credentials, malformed body, rejected sender_id, etc.) — `sendSmsNoRetry` throws `TermiiError` with `httpStatus` in `[400, 500)`:
   - `UPDATE sms_queue SET status='failed', last_attempt_at=now() WHERE id = $1`. The row is NOT retried; 4xx is a permanent caller-side fault.
   - Emit `sms.failed` audit event with payload `{ template_key, recipient_phone_hash, http_status, error_excerpt }` where `error_excerpt = TermiiError.bodyExcerpt.slice(0, 200)`. Note: `bodyExcerpt` is already OTP-scrubbed by the Story 1.5 review fix in `termii-client.ts`.
   - The 4xx outcome is rare in production (sender_id is approved, credentials are rotated server-side). Worth flagging operationally: a worker tick with `rows_failed > 0` should page (Story 6.X observability — out of scope; document as future work).

7. **Worker outcome — Termii 5xx / timeout / network error (retryable).** `sendSmsNoRetry` throws `TermiiError` with `httpStatus >= 500` (or 504 from `AbortController` timeout — already wrapped by `termii-client.ts:97-103`):
   - **Increment** `retry_count` and **schedule** `next_retry_at`.
   - **Backoff schedule** (architecture.md:643 — *"Exponential backoff 10 s → max 10 min"*):
     - Attempt 0 → 1: `next_retry_at = now() + 10 s`
     - Attempt 1 → 2: `+ 30 s`
     - Attempt 2 → 3: `+ 60 s` (1 min)
     - Attempt 3 → 4: `+ 120 s` (2 min)
     - Attempt 4 → 5: `+ 300 s` (5 min)
     - Attempt 5+: `+ 600 s` (10 min — capped)
     - **Pure function**: implement as `function backoffDelaySeconds(retryCount: number): number` in `supabase/functions/sms-worker/backoff.ts` so it's unit-testable in isolation.
   - `UPDATE sms_queue SET retry_count = retry_count + 1, next_retry_at = now() + (<delay> || ' seconds')::interval, last_attempt_at = now() WHERE id = $1` — note the row stays `status='queued'` (still in the drain pool); only `next_retry_at` gates re-drain.
   - **NO audit event for transient retry attempts** (would explode chain volume — a 24 h flapping outage at 5-min cadence = ~280 events for one row). Audit events fire only on terminal transitions: `sms.sent`, `sms.failed`, `sms.abandoned`.
   - Log structured JSON `{ outcome: 'scheduled_retry', queue_id, retry_count: <new>, next_retry_at: <iso>, http_status }` so operators can observe retry pressure.

8. **Worker outcome — abandonment after 24 h.** If `now() - created_at >= interval '24 hours'` AND the next failure would be the abandonment trigger (i.e., we just failed transiently AND the row has been in the queue ≥ 24 h):
   - **Override the schedule-retry path**: instead of incrementing `retry_count` + setting `next_retry_at`, the worker sets:
     - `UPDATE sms_queue SET status='abandoned', abandoned_at=now(), last_attempt_at=now() WHERE id = $1`.
   - Emit `sms.abandoned` audit event with payload `{ template_key, recipient_phone_hash, retry_count, age_seconds: extract(epoch from now() - created_at) }`.
   - **Why 24 h, not retry_count-based**: architecture.md:643 commits to *"abandon after 24 h"* — a wall-clock threshold, not a retry-count threshold. With the backoff schedule above, 24 h corresponds to ~144 retries (24 h × 60 min / 10 min cap = 144) — too many to use a count-based threshold cleanly. The wall-clock approach also handles the "Termii outage spans midnight" case naturally.
   - **Order of evaluation**: the wall-clock check runs AFTER the Termii call returns the 5xx (the worker has just decided this is a retry case; it then asks "should I retry, or abandon?"). It does NOT pre-empt the dispatch attempt — every drain re-attempts dispatch first.

9. **Worker outcome — undone-transaction skip (Story 4.5 handshake).** The drain query already filters `t.undone_at IS NULL`. If a row is mid-flight (drained by the worker, transaction is then undone via `undo_transaction` RPC during the Termii call), the per-row `FOR UPDATE` re-claim still proceeds because `undone_at` is on `transactions`, not `sms_queue`. The worker MUST re-check inside the per-row tx:
   ```sql
   SELECT 1 FROM public.transactions t WHERE t.id = $1 AND t.undone_at IS NULL;
   ```
   If 0 rows → the transaction was undone after drain. Action: `UPDATE sms_queue SET status='abandoned', abandoned_at=now() WHERE id = $1`. Log `outcome: 'skipped', reason: 'transaction_undone'`. **Do NOT emit `sms.abandoned`** — the undo path already emitted `transaction.undone`; double-auditing is noise. (This diverges from AC #8's abandonment path; rationale: AC #8 abandons on Termii outage; this AC abandons on upstream undo. Different cause = different audit posture.)

10. **`audit_append_external` allowlist extension.** Migration `20260428000001_audit_append_external_extend_sms_events.sql`:
    - `CREATE OR REPLACE FUNCTION public.audit_append_external(...)` — same signature, same SECURITY DEFINER + search_path, same byte-for-byte canonical-serialisation logic (mirrors `audit_emit` per Story 4.5 / 3.3 / 2.5 patches — DO NOT drift).
    - Replace the `IF p_event_type NOT IN ('sms.queued') THEN ... END IF;` line with `IF p_event_type NOT IN ('sms.queued', 'sms.sent', 'sms.failed', 'sms.abandoned') THEN ... END IF;`.
    - **Do NOT touch any other line** — the canonical serialiser MUST stay identical; the only delta is the allowlist set.
    - Update the function comment to enumerate the new allowed types.
    - **Re-derive from migration `20260427000005_audit_append_external.sql`** (the Story 6.1 baseline) — copy-paste the entire body and edit only the allowlist line + the comment. Mirror Story 4.5's pattern (it had to re-derive `audit_emit` from migration 0025 to add `transaction.undone`).

11. **Audit emission from the worker (Edge Function side).** The worker calls `audit_append_external` via a **JWT-bound client built from the row's `collector_id`**, NOT the worker's service-role identity. Pattern:
    - The worker authenticated as service-role at the Edge Function entry. To emit an audit event tagged with the *correct* `collector_id` (the saver's owning collector), the worker must supply that identity to the SECURITY DEFINER function via `auth.uid()`.
    - The 3-tier actor JWT fallback in `audit_append_external` (Story 2.5 fix mirrored in Story 6.1) reads `request.jwt.claim.sub` → `request.jwt.claims->'sub'` → `'system'`.
    - **Worker approach**: mint a short-lived JWT for `sq.collector_id` using `serviceClient.auth.admin.generateLink({ type: 'magiclink', email: '...' })` is wrong (no email path). Cleaner: use `service_role` to set the session-level config: `SELECT set_config('request.jwt.claim.sub', $1, true);` immediately before calling `audit_append_external`. The `true` flag scopes to the current transaction. Then call the function within the same tx.
    - The `auth.uid()` call inside `audit_append_external` reads `current_setting('request.jwt.claim.sub')` (Supabase's auth schema mirrors this convention). Verify with the existing `audit_emit` pattern — if `auth.uid()` does NOT resolve from `request.jwt.claim.sub` directly, fall back to passing `collector_id` as an explicit RPC parameter (a cleaner signature: `audit_append_external(p_event_type, p_entity_id, p_entity_table, p_payload, p_collector_id)` — this is a NEW migration, not editing 6.1's allowlist).
    - **Decision (in implementation):** if `set_config('request.jwt.claim.sub', ...)` works (verify by inspecting `auth.uid()` source — it's `(current_setting('request.jwt.claim.sub', true))::uuid`), use that; else add the `p_collector_id` parameter. Either approach is acceptable; pick the one that keeps `auth_emit`'s shape consistent. **Implementer should test both during dev and pick one — document choice in story Dev Notes.**

12. **Scheduling — pg_cron migration.** Migration `20260428000002_schedule_sms_worker.sql`:
    - Enable `pg_cron` if not already enabled (it ships with Supabase but the schema may need an explicit `CREATE EXTENSION IF NOT EXISTS pg_cron;`).
    - Schedule the worker:
      ```sql
      SELECT cron.schedule(
        'sms-worker-drain',
        '*/30 * * * * *',  -- every 30 seconds (extended cron syntax — pg_cron supports seconds)
        $$
        SELECT net.http_post(
          url := <SUPABASE_URL_FROM_VAULT> || '/functions/v1/sms-worker',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || <SERVICE_ROLE_KEY_FROM_VAULT>
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 55000
        ) AS request_id;
        $$
      );
      ```
    - **Critical — secrets handling**: the SUPABASE_URL and SERVICE_ROLE_KEY MUST come from Vault (`vault.secrets`), NOT a hard-coded string in the migration. Pattern: `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' INTO <local var>`. If Vault doesn't have the secrets at MVP, document the deferral and surface a follow-up: *"Story 6.2 schedule is parked behind a Vault setup task — ops manually inserts the cron schedule once secrets land. Migration ships the helper SQL but the `cron.schedule(...)` call is commented out with a TODO."*
    - **Test approach**: the schedule is hard to unit-test. Instead, contract-test the *worker's idempotency under repeated invocation* (calling `/sms-worker` 3× back-to-back should not double-process any row, thanks to `FOR UPDATE SKIP LOCKED`). Schedule integrity is verified manually post-deploy.
    - Migration is **idempotent** — wrap `cron.schedule` in `IF NOT EXISTS` semantics: `SELECT cron.schedule(...) WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sms-worker-drain');`. (pg_cron does not support `IF NOT EXISTS` natively; emulate.)

13. **Performance budget (NFR-P4).** The BDD line 983 commits to: *"p95 time from `pending` insertion to `delivered_at` timestamp is ≤ 60 s"*. Story 6.2's `delivered_at` stays NULL (delivery webhook is deferred — AC #14), so reframe the SLO as **"p95 time from row INSERT to `status='sent'` ≤ 60 s under steady-state load"**. With:
    - 30 s scheduler cadence
    - ~5 s Termii round-trip (TERMII_REQUEST_TIMEOUT_MS = 5_000 ms per `_shared/constants.ts:13`)
    - `batch_size = 10` (10 sequential Termii calls per drain ≈ 50 s worst case in steady state)
    The worst-case latency for a row landing right after a drain tick fires is `30 s (wait for next tick) + 50 s (worst-case batch position) = 80 s` — exceeds the 60 s budget. Mitigation paths to discuss in Dev Notes:
    - (a) Reduce drain cadence to 10 s. Trade-off: 3× the scheduler load.
    - (b) Parallelise Termii calls within a batch with `Promise.all(rows.map(...))` — bounded to ≤ 10 concurrent fetches per Termii rate-limit.
    - (c) Accept the gap until Story 6.X tunes the scheduler.
    - **Decision for MVP**: (b) parallelise Termii calls (bounded to `batch_size`). Each row's per-row tx is independent; `Promise.all` keeps end-to-end batch latency at ~5 s instead of ~50 s, putting p95 within the 60 s budget. Document the choice + the rationale in implementation.

14. **Delivery-receipt webhook — explicitly deferred.** Termii delivers a delivery-receipt callback to a configurable webhook URL when SMS reaches the handset. Story 6.2 does NOT ship the receiver. Deferral notes:
    - Story 6.X (TBD — not in current epic) ships a `/functions/v1/sms-delivery-webhook` endpoint that accepts Termii's POST payload, validates the message_id, and `UPDATE sms_queue SET status='delivered', delivered_at=now()` for the matching row.
    - Until then, `delivered_at` stays NULL for every row — the UI (Story 6.6 message-history surface) MUST treat `status='sent'` as the terminal-success state and show "Envoyé" rather than "Livré".
    - The `sms_queue_status_enum` already includes `delivered` (Story 1.2), so no schema work is needed for the future webhook; only the function-level wiring.
    - Document this in `architecture.md`'s open questions OR a Story 6.2 Dev Notes line — the implementation phase should NOT silently inherit "sent ≠ delivered" without flagging it.

15. **No new dependencies.** The worker uses:
    - `jsr:@supabase/supabase-js@2` (already a dep)
    - `_shared/auth-check.ts` (existing — but extend its service-role check; see AC #1)
    - `_shared/rfc7807.ts` (existing — extend with `auth_service_role_required`)
    - `_shared/termii-client.ts` (existing — extend with `sendSmsNoRetry`)
    - Local: `supabase/functions/sms-worker/backoff.ts` (NEW pure module — exports `backoffDelaySeconds(retryCount: number): number`)
    - No npm/jsr additions.

16. **No new i18n keys.** Story 6.2 is backend-only. UI surface lands in Story 6.6 (resend / cycle history).

17. **Tests — backoff module unit (Deno).** New `supabase/functions/sms-worker/backoff.test.ts`:
    - `backoffDelaySeconds(0) === 10`
    - `backoffDelaySeconds(1) === 30`
    - `backoffDelaySeconds(2) === 60`
    - `backoffDelaySeconds(3) === 120`
    - `backoffDelaySeconds(4) === 300`
    - `backoffDelaySeconds(5) === 600`
    - `backoffDelaySeconds(50) === 600` (capped — verify monotonic non-decreasing AND capped at 600)
    - `backoffDelaySeconds(-1)` throws (negative count is a programming error — defensive)
    - Each assertion as a separate `Deno.test` for granular failure messaging.

18. **Tests — Edge Function contract (Deno).** New `supabase/functions/sms-worker/index.test.ts`. Pattern mirrors `supabase/functions/sms-dispatch/index.test.ts` (env-skip block + `seedCollector` + per-test `denoOpts: { sanitizeResources: false, sanitizeOps: false }`). Cases:
    1. **Auth — anonymous request → 401 `auth_unauthenticated`.** No Authorization header.
    2. **Auth — collector JWT → 403 `auth_service_role_required`.** Pass a regular collector JWT; assert 403 + RFC 7807 type ends with `/auth/service_role_required`.
    3. **Method — GET → 405 `method_not_allowed`.** Mirrors Story 6.1's Kong-aware GET test (must include service-role JWT to bypass Kong).
    4. **Body — `batch_size: 0` → 400 `request_invalid`.** Schema CHECK rejects.
    5. **Body — `batch_size: 101` → 400 `request_invalid`.** Schema CHECK rejects.
    6. **Drain — empty queue → 200 `{ drained: 0, sent: 0, scheduled_retry: 0, ... }`.** Service-role JWT, no rows.
    7. **Drain — one ready row, Termii returns 200 → row.status='sent', message_id stored, audit emits `sms.sent`.** Use the existing `installFetchRecorder` from `_shared/test-utils.ts` (already used for Termii mocking — see line 96 of test-utils.ts) to stub Termii's `/api/sms/send` endpoint.
    8. **Drain — one row, Termii returns 502 → row.retry_count=1, next_retry_at ≈ now() + 10 s (within 1 s tolerance), status stays 'queued', NO audit event.**
    9. **Drain — one row, Termii returns 400 → row.status='failed', audit emits `sms.failed`.**
    10. **Drain — one row, retry_count=10, age_seconds < 24h, Termii returns 502 → row.retry_count=11, next_retry_at ≈ now() + 600 s (capped), status 'queued', NO audit.**
    11. **Drain — one row, age_seconds >= 24h * 3600, Termii returns 502 → row.status='abandoned', abandoned_at set, audit emits `sms.abandoned`.** Test seeds the row with `created_at = now() - interval '24 hours 1 minute'` via service-role direct INSERT.
    12. **Drain — one row, transaction undone (`undone_at NOT NULL`) → row.status='abandoned' (no audit, NOT `sms.abandoned`), log `reason: 'transaction_undone'`.** Test calls `undo_transaction` RPC after seeding the row but before invoking the worker.
    13. **Drain — concurrency: two simultaneous worker invocations with overlapping batches drain disjoint rows.** Seed 5 rows. Spawn 2 fetches with `Promise.all`. Stub Termii to return 200. Assert: combined `sent` count across the two responses is exactly 5; no row is `sent` twice (impossible by FK / status enum but assert via `SELECT count(*) WHERE status='sent'` post-test).
    14. **Drain — `dry_run: true` → reads rows, calls Termii nothing, status unchanged.** Stub Termii fetch to throw if invoked; assert no rows mutated; assert response says `drained: <n>, sent: 0` (or surface a `dry_run: true` field).

19. **Tests — DB / migration contract (Deno).** New `supabase/functions/_shared/sms-worker-audit-allowlist.contract.test.ts`:
    1. `audit_append_external('sms.sent', ...)` succeeds and inserts an audit_log row with the correct hash chain (verify `entry_hash` deterministic across two test runs given identical inputs — re-uses Story 6.1's existing test pattern).
    2. `audit_append_external('sms.failed', ...)` succeeds.
    3. `audit_append_external('sms.abandoned', ...)` succeeds.
    4. `audit_append_external('sms.delivered', ...)` raises `22000` (NOT in allowlist — guards against drift / Story 6.X premature emission).
    5. `audit_append_external('sms.queued', ...)` STILL succeeds (regression test — Story 6.1 path must not break).

20. **Tests — pg_cron schedule contract (Deno).** New `supabase/functions/_shared/sms-worker-cron-schedule.contract.test.ts`:
    1. `SELECT * FROM cron.job WHERE jobname='sms-worker-drain'` returns exactly 1 row.
    2. The job's `schedule` column equals `'*/30 * * * * *'`.
    3. The job is `active = true`.
    4. **Skip if** `pg_cron` extension not installed (some local dev stacks don't ship it — make this skip gracefully like the existing env-skip pattern).

21. **No production E2E test.** The worker is invoked by pg_cron, not by a user flow. The contract tests above are sufficient. (UI testing lands in Story 6.6 when "Renvoyer le reçu" surfaces.)

22. **Run-edge-tests update.** Add the 4 new Deno test paths to `scripts/run-edge-tests.sh`:
    - `supabase/functions/sms-worker/backoff.test.ts`
    - `supabase/functions/sms-worker/index.test.ts`
    - `supabase/functions/_shared/sms-worker-audit-allowlist.contract.test.ts`
    - `supabase/functions/_shared/sms-worker-cron-schedule.contract.test.ts`

23. **Audit chain integrity — preserved.** The migration `20260428000001_audit_append_external_extend_sms_events.sql` MUST keep the canonical-serialisation logic byte-for-byte identical to Story 6.1's baseline (`20260427000005_audit_append_external.sql`), which in turn mirrors `audit_emit`'s logic from migration `20260423000003_audit_emit_promote_cycle.sql` (Story 3.3) and `20260426000005_audit_emit_transaction_undone.sql` (Story 4.5) byte-for-byte. The 3-tier actor JWT fallback (Story 2.5 fix), the per-collector advisory lock, and the `convert_to(...)`-style `bytea` concatenation MUST all remain identical. **Diff against the Story 6.1 baseline should show ONE line changed: the allowlist set + ONE comment line.**

24. **Defence-in-depth (mirrors prior stories).** The worker's "skip undone transactions" filter is layered:
    - DB level: drain query's `LEFT JOIN transactions ... WHERE undone_at IS NULL`.
    - Worker per-row level: re-check inside the per-row tx (AC #9).
    - Audit event integrity: no `sms.sent` event ever emits for an undone transaction (the per-row check prevents the dispatch; the audit event only fires post-dispatch).

## Tasks / Subtasks

- [ ] **Task 1 — Migration: extend audit allowlist** (AC: #10, #23)
  - [ ] Re-derive from `20260427000005_audit_append_external.sql`; copy the entire function body.
  - [ ] Edit ONLY the allowlist `IF p_event_type NOT IN (...)` line to include `'sms.sent', 'sms.failed', 'sms.abandoned'` alongside the existing `'sms.queued'`.
  - [ ] Update the function comment to enumerate the new allowed types.
  - [ ] Save as `supabase/migrations/20260428000001_audit_append_external_extend_sms_events.sql`.
  - [ ] Apply via `npm run db:migrate` (CLAUDE.md anti-pattern: do NOT use `db:reset`).
  - [ ] Regenerate types: `npm run db:types --local` → updates `src/infrastructure/supabase/database.types.ts` (no schema change beyond the function — types should be a no-op in practice).

- [ ] **Task 2 — Migration: pg_cron schedule for the worker** (AC: #12)
  - [ ] Save as `supabase/migrations/20260428000002_schedule_sms_worker.sql`.
  - [ ] `CREATE EXTENSION IF NOT EXISTS pg_cron;` (no-op if already installed by the Supabase init script).
  - [ ] Implement Vault secret retrieval for `SUPABASE_URL` and `SERVICE_ROLE_KEY` (defer to a TODO + comment-out if Vault isn't seeded locally — document the manual ops step).
  - [ ] Wrap `cron.schedule('sms-worker-drain', '*/30 * * * * *', ...)` in idempotency check `WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='sms-worker-drain')`.
  - [ ] `timeout_milliseconds := 55000` to keep below the 60 s Edge Function wall-clock.

- [ ] **Task 3 — Extend `_shared/rfc7807.ts` with `auth_service_role_required`** (AC: #1)
  - [ ] Add `auth_service_role_required: { status: 403, type: '${PROBLEM_BASE}/auth/service_role_required', title: 'Service role required' }` to `KNOWN_PROBLEMS`.

- [ ] **Task 4 — Extend `_shared/termii-client.ts` with `sendSmsNoRetry`** (AC: #4)
  - [ ] Export `sendSmsNoRetry` as either an alias for the internal `sendOnce` OR a thin wrapper that calls `sendOnce` once.
  - [ ] Add JSDoc contrasting it with `sendSms()`.
  - [ ] Do NOT modify `sendSms()` (Story 1.3's OTP path depends on it).

- [ ] **Task 5 — Pure `backoffDelaySeconds` module** (AC: #7, #17)
  - [ ] `supabase/functions/sms-worker/backoff.ts` — exports `backoffDelaySeconds(retryCount: number): number`.
  - [ ] Schedule: `[10, 30, 60, 120, 300, 600]` clamped at 600 for `retryCount >= 5`.
  - [ ] Throws on negative input.
  - [ ] `supabase/functions/sms-worker/backoff.test.ts` covers all 8 cases.

- [ ] **Task 6 — Worker Edge Function** (AC: #1, #2, #3, #5, #6, #7, #8, #9, #11)
  - [ ] `supabase/functions/sms-worker/index.ts` — POST-only Deno.serve handler.
  - [ ] Local JWT decode (no signature verify) → check `role === 'service_role'` → else 403.
  - [ ] Zod-validate body `{ batch_size?: number (1..100), dry_run?: boolean }`.
  - [ ] Drain via the SQL in AC #2 with `FOR UPDATE SKIP LOCKED`.
  - [ ] Per-row processing loop with one tx per row (AC #3).
  - [ ] Termii call via `sendSmsNoRetry`; outcome dispatch to AC #5/#6/#7/#8/#9 paths.
  - [ ] Audit emission via `audit_append_external` with collector_id propagation (AC #11 — pick the cleaner approach during dev and document in Dev Notes).
  - [ ] Structured JSON logging per AC #1; NEVER plaintext phone or body.
  - [ ] Final response `{ drained, sent, scheduled_retry, abandoned, failed, skipped }`.
  - [ ] **Performance**: parallelise Termii calls within the batch via `Promise.all` (AC #13) — each row's per-row tx is independent, so concurrent dispatch is safe. **CAUTION**: do NOT share the same DB transaction across `Promise.all` branches; each call needs its own client connection or its own short-lived service-role connection. Using one `serviceClient` instance with separate `.from(...)` calls is fine — supabase-js handles connection pooling internally.

- [ ] **Task 7 — Edge Function contract tests** (AC: #18)
  - [ ] **First**: extract `seedCollector` + `seedMemberWithCycle` from `_shared/sms-dispatch-trigger.contract.test.ts` into a NEW non-test module `supabase/functions/_shared/test-fixtures.ts` (Deno test files importing from other test files is anti-pattern — make them helpers). Update Story 6.1's `sms-dispatch-trigger.contract.test.ts` AND `sms-dispatch/index.test.ts` to import from the new fixtures module (mechanical rename — no behaviour change).
  - [ ] `supabase/functions/sms-worker/index.test.ts` — 14 cases per AC #18.
  - [ ] Use `installFetchRecorder` from `_shared/test-utils.ts` to stub Termii at `https://v3.api.termii.com/api/sms/send`.
  - [ ] Each test gets `denoOpts: { sanitizeResources: false, sanitizeOps: false }` to avoid Deno's leaked-handle false positives that have plagued every previous Edge Function test.

- [ ] **Task 8 — DB allowlist contract tests** (AC: #19)
  - [ ] `supabase/functions/_shared/sms-worker-audit-allowlist.contract.test.ts` — 5 cases per AC #19.

- [ ] **Task 9 — pg_cron schedule contract test** (AC: #20)
  - [ ] `supabase/functions/_shared/sms-worker-cron-schedule.contract.test.ts` — 4 cases per AC #20 incl. graceful skip if pg_cron not installed.

- [ ] **Task 10 — Wire test paths into `scripts/run-edge-tests.sh`** (AC: #22)

- [ ] **Task 11 — Verify all gates green**
  - [ ] `npm run typecheck`
  - [ ] `npm run lint`
  - [ ] `npm run test` (vitest — should be a no-op for this story; sanity)
  - [ ] `npm run test:edge` (Deno — runs the new tests)
  - [ ] `npm run build` (sanity — ensure no client-side import accidentally pulls Edge Function code)
  - [ ] Spot-check: `select cron.schedule from cron.job where jobname='sms-worker-drain';` returns the expected pattern.

## Dev Notes

### Architecture intelligence

- **architecture.md:643** — *"SMS dispatch (Termii) | Exponential backoff 10 s → max 10 min; abandon after 24 h; surfaced in Progressive Toast (NFR-R4)"*. The 10 s → 10 min schedule is the source of truth for AC #7's table.
- **architecture.md:826** — Source-tree slot reserved: `supabase/functions/sms-worker/index.ts`. This story fills it.
- **architecture.md:1043** — *"SMS worker (drain queue) | Edge Function `/functions/v1/sms-worker` (scheduled) | Service role"*. Service-role auth is mandatory (AC #1).
- **architecture.md:1100** — *"NFR-P4 (60 s SMS) | SMS worker config (`supabase/functions/sms-worker/`); monitored via audit log timing"*. The SLO is enforced via batch parallelisation (AC #13 decision).
- **architecture.md:1129** — *"Termii — called from Edge Functions (`sms-worker`) over HTTPS. Never from the browser."* Confirms server-side-only.
- **architecture.md:1141** (data flow #6) — *"sms-worker Edge Function (scheduled) drains sms_queue, calls Termii, updates status."* This story implements that step.

### Story 6.1 handshake — the foundation we build on

- The `sms_queue` schema additions (`template_key`, `retry_count`, `next_retry_at`, `abandoned_at`) are already in place; AC #2's drain query uses them directly.
- The partial drain index `idx_sms_queue_drain_ready` on `(next_retry_at NULLS FIRST, created_at) WHERE status='queued' AND abandoned_at IS NULL` accelerates the drain query — verify the query plan uses it via `EXPLAIN ANALYZE` during dev (best-effort; acceptable to skip in unit tests).
- `audit_append_external` already does the canonical-serialisation byte-for-byte work; Story 6.2 only extends its allowlist via Task 1.

### Story 4.5 handshake — soft-undo + cascade flip

- The worker MUST NOT dispatch SMS for soft-undone transactions. Two layers (drain query + per-row re-check) guard this.
- The CASCADE → SET NULL flip means orphaned `sms_queue` rows (transaction_id = NULL) can exist for pre-4.5 data; the drain query's `LEFT JOIN ... OR t.id IS NULL` accepts these — they dispatch their stub body and exit normally.

### Story 6.5 handshake — opt-out

- Both the trigger (Story 6.1) and the worker (this story) need an `IF FALSE THEN ... END IF` placeholder for `members.sms_opt_out`. Story 6.5 will replace `FALSE` with the real boolean expression in BOTH places. Keep the structural slot identical between trigger and worker so 6.5's diff is symmetric.

### Story 6.3 handshake — template body

- Story 6.3 will replace the trigger function (and possibly the dispatch Edge Function) to render the real SMS body via `format_sms_body(template_key, transaction_id)`. The worker reads `body` from the row as-is and passes it to Termii — no re-interpretation. **The worker is template-agnostic.**

### Story 6.4 handshake — receipt URL

- Story 6.4 ships the Cloudflare Worker that serves the receipt URL. The body Story 6.3 will eventually render includes `https://safaricash.app/r/<token>`. The worker (this story) does not care about URL composition; it just dispatches whatever body the row holds.

### Performance + concurrency caveats

- **`FOR UPDATE SKIP LOCKED`** is the standard PostgreSQL pattern for queue draining. It bounds concurrency without contention: two workers running simultaneously partition the queue cleanly. Document the choice + its rationale in implementation comments.
- **`Promise.all` parallelisation across rows** is what makes the 60 s p95 budget achievable — without it, a 10-row batch with 5 s Termii calls would take ~50 s sequentially. Each `Promise.all` branch opens its own per-row tx; supabase-js's connection pool handles up to 20 concurrent connections by default (Supabase Edge Functions allocate enough).
- **Edge Function 60 s wall-clock** — `pg_cron` calls `net.http_post(...)` with `timeout_milliseconds := 55000` to leave a 5 s buffer. The worker's drain query + per-row processing must complete well within that — if the queue is large (>100 ready rows), only `batch_size` (default 10) is drained per tick; subsequent ticks pick up the rest. The 30 s schedule + 10-row batches drain ~1200 rows/hour steady-state — enough for 50 collectors × ~20 transactions/collector/day.

### Audit-chain non-drift discipline (mirrors Story 4.5 + 3.3 + 2.5 patches)

- The `audit_append_external` migration MUST diff to ONE allowlist line + ONE comment line vs. Story 6.1's baseline. ANY OTHER DRIFT (whitespace, variable rename, comment cleanup) breaks the byte-for-byte canonical serialisation contract and forks every collector's chain. Use `git diff supabase/migrations/20260427000005_audit_append_external.sql supabase/migrations/20260428000001_audit_append_external_extend_sms_events.sql` as the verification step — the diff should be 2-3 lines max.

### Project structure notes

- Source tree:
  - NEW: `supabase/functions/sms-worker/index.ts`
  - NEW: `supabase/functions/sms-worker/backoff.ts`
  - NEW: `supabase/functions/sms-worker/backoff.test.ts`
  - NEW: `supabase/functions/sms-worker/index.test.ts`
  - NEW: `supabase/functions/_shared/sms-worker-audit-allowlist.contract.test.ts`
  - NEW: `supabase/functions/_shared/sms-worker-cron-schedule.contract.test.ts`
  - NEW: `supabase/migrations/20260428000001_audit_append_external_extend_sms_events.sql`
  - NEW: `supabase/migrations/20260428000002_schedule_sms_worker.sql`
  - MODIFIED: `supabase/functions/_shared/rfc7807.ts` (one new key)
  - MODIFIED: `supabase/functions/_shared/termii-client.ts` (one new export)
  - MODIFIED: `scripts/run-edge-tests.sh` (4 new test paths)
  - MODIFIED: `src/infrastructure/supabase/database.types.ts` (re-generated; should be near-no-op)
  - MODIFIED: `_bmad-output/implementation-artifacts/sprint-status.yaml` (mark 6-2 → review on completion)
- All paths align with architecture.md § Source Tree.
- No conflicts with prior stories.

### Testing standards

- Edge Function tests use Deno + `jsr:@std/assert@1` (already-established pattern across Stories 1.5b, 4.4, 4.5, 5.4, 6.1).
- Termii is stubbed via `installFetchRecorder` from `_shared/test-utils.ts` (reuse, do not re-invent).
- Each test seeds its own collector + member via `service.auth.admin.createUser` + the `users` table INSERT (mirror existing `seedCollector` helper from `_shared/sms-dispatch-trigger.contract.test.ts:31` — extract to a shared `_shared/test-fixtures.ts` if the duplication makes the third copy land here).
- Per-test cleanup deletes transactions / cycles / members / users in that order.
- `denoOpts: { sanitizeResources: false, sanitizeOps: false }` on every test to avoid the Supabase JS client's known leaked-handle false positives.
- Coverage gate: 100 % on `backoff.ts` (it's a pure module — must be exhaustive). Worker `index.ts` + migrations covered by the 14-case contract test suite.

### References

- [Source: epics.md#Story 6.2] — BDD acceptance criteria.
- [Source: architecture.md#Retry strategies (line 643)] — Backoff schedule + 24 h abandon.
- [Source: architecture.md#Edge Functions source tree (line 826)] — Source path slot.
- [Source: architecture.md#NFR-P4 (line 1100)] — 60 s SMS SLO.
- [Source: architecture.md#Authentication trust matrix (line 1043)] — Service-role auth requirement.
- [Source: 6-1-sms-dispatch-edge-function.md] — `sms_queue` schema extensions, `audit_append_external` baseline, JWT decoding patterns.
- [Source: supabase/migrations/20260427000005_audit_append_external.sql] — Canonical-serialisation reference for the allowlist-extension migration.
- [Source: supabase/functions/_shared/termii-client.ts] — `sendOnce`/`sendSms` baseline for `sendSmsNoRetry`.
- [Source: supabase/functions/_shared/test-utils.ts:96] — `installFetchRecorder` Termii stub pattern.
- [Source: supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts] — `seedCollector` / `seedMemberWithCycle` reuse target.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

### Completion Notes List

Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
