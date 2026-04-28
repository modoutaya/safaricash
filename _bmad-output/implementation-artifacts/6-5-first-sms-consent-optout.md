# Story 6.5: First-SMS consent notice and opt-out mechanism

Status: review

## Story

As a **saver**,
I want **the first SMS I receive to explain what SafariCash is and how I can opt out**,
so that **I consent to receiving further SMS under UEMOA data protection (FR31).**

> **Predicate of this story.** Story 6.1 shipped the trigger with a structural placeholder (`IF FALSE THEN ...`) for the opt-out check. Story 6.3 ships the `first_receipt` template that already includes *"Repondez STOP pour ne plus recevoir."* (the user-visible instruction); Story 6.4 ships the receipt page. Story 6.5 closes the consent loop by wiring the actual opt-out **side-effects**: schema (`members.sms_opt_out`), trigger replacement (replace `IF FALSE` with the real check), audit-allowlist extension (`sms.opt_out`), a SECURITY DEFINER RPC `set_member_sms_opt_out`, and TWO opt-out paths — (a) Termii inbound webhook for `STOP` keyword replies; (b) a POST endpoint on the receipt-url Cloudflare Worker (`POST /r/{token}/opt-out`) that the receipt page links to. **What Story 6.5 does NOT ship**: a re-opt-in mechanism (saver who later changes mind cannot self-re-enable; collector or support intervention is required — out of scope for MVP); per-phone deduplication across collectors (a saver's phone might appear in multiple collector member lists; opt-out is per-member-row, not per-phone — accepted MVP trade-off); opt-out via WhatsApp (Story 6.8 territory).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 1032-1039; the rest are spec-derived constraints required for a flawless implementation.

1. **Schema — `members.sms_opt_out` columns.** New migration `20260501000001_add_sms_opt_out_to_members.sql`:
   - `ALTER TABLE public.members ADD COLUMN sms_opt_out boolean NOT NULL DEFAULT false;`
   - `ALTER TABLE public.members ADD COLUMN sms_opt_out_at timestamptz NULL;` — observability column; set when `sms_opt_out` flips false → true.
   - `ALTER TABLE public.members ADD COLUMN sms_opt_out_via text NULL CHECK (sms_opt_out_via IS NULL OR sms_opt_out_via IN ('stop_keyword', 'receipt_url', 'collector_action'));` — analytics; `'collector_action'` reserved for a future Story-6.X UI surface.
   - **No backfill needed** — all existing rows default to `sms_opt_out=false`, NULL `sms_opt_out_at` / `sms_opt_out_via`.
   - **Partial index** for the trigger's hot path: `CREATE INDEX idx_members_sms_opt_out ON public.members (id) WHERE sms_opt_out = true;` — tiny, only contains opted-out rows; the trigger's `members WHERE id = NEW.member_id AND sms_opt_out = true` check is O(1).

2. **Trigger replacement — `enqueue_sms_on_transaction`.** Migration `20260501000002_enqueue_sms_optout_check.sql`:
   - Re-derive function body from migration 0042 (Story 6.3's version).
   - **Replace ONLY** the `IF FALSE THEN ... END IF;` placeholder block with the real check:
     ```sql
     declare v_opt_out boolean;
     ...
     select sms_opt_out into v_opt_out from public.members where id = new.member_id;
     if v_opt_out then return null; end if;
     ```
   - Trigger ordering / SECURITY DEFINER / search_path / template_key picking / format_sms_body call — UNCHANGED. Diff vs migration 0042 should be ~5 lines (the new SELECT + IF). Mirror Story 6.2's audit-allowlist diff discipline.

3. **`audit_append_external` allowlist extension** — migration `20260501000003_audit_append_external_extend_optout.sql`:
   - Re-derive from migration 0037 (Story 6.2's audit-allowlist baseline).
   - Replace `IF p_event_type NOT IN ('sms.queued', 'sms.sent', 'sms.failed', 'sms.abandoned')` with `IF p_event_type NOT IN ('sms.queued', 'sms.sent', 'sms.failed', 'sms.abandoned', 'sms.opt_out')`.
   - Update the function comment.
   - Diff vs migration 0037: 1 allowlist line + 1 comment line. Same byte-for-byte canonical-serialiser discipline.

4. **`set_member_sms_opt_out` RPC** — migration `20260501000004_set_member_sms_opt_out.sql`:
   ```sql
   create or replace function public.set_member_sms_opt_out(
     p_member_id uuid,
     p_via       text
   )
   returns void
   language plpgsql
   security definer
   set search_path = public, pg_temp
   as $$
   declare
     v_collector_id uuid;
     v_already      boolean;
   begin
     if p_via not in ('stop_keyword', 'receipt_url', 'collector_action') then
       raise exception 'invalid_via: % is not a recognised opt-out source', p_via
         using errcode = '22000';
     end if;

     select collector_id, sms_opt_out
       into v_collector_id, v_already
       from public.members
       where id = p_member_id;

     if v_collector_id is null then
       raise exception 'member_not_found' using errcode = 'P0002';
     end if;

     -- Idempotent: already opted out → no-op (no second audit event).
     if v_already then return; end if;

     update public.members
        set sms_opt_out    = true,
            sms_opt_out_at = now(),
            sms_opt_out_via = p_via
      where id = p_member_id;

     -- Cancel any queued (un-dispatched) SMS rows for this member's
     -- transactions — the worker will not pick them up after this
     -- migration, but a fresh row could land mid-flight. Match the
     -- Story 4.5 undo_transaction cancellation pattern.
     update public.sms_queue sq
        set status = 'abandoned', abandoned_at = now()
       from public.transactions t
      where t.id = sq.transaction_id
        and t.member_id = p_member_id
        and sq.status = 'queued';

     -- Audit emit via the 5-arg overload (Story 6.2).
     perform public.audit_append_external(
       'sms.opt_out',
       p_member_id,
       'members',
       jsonb_build_object('via', p_via),
       v_collector_id
     );
   end;
   $$;
   ```
   - GRANT EXECUTE TO service_role; REVOKE FROM public + authenticated.
   - The Termii inbound webhook + the receipt-url Worker both call this RPC under service-role.

5. **Termii inbound webhook Edge Function `/functions/v1/sms-inbound`** at `supabase/functions/sms-inbound/index.ts`:
   - **Method:** POST only (else 405).
   - **Auth:** Termii's inbound webhook posts include the API key in the request body (per Termii v3 docs). We require **TWO** layered defences:
     - (a) `TERMII_INBOUND_SECRET` env var — a shared static secret the operator configures in the Termii dashboard's webhook URL as a query-string parameter (`?secret=<value>`). The Edge Function rejects requests whose query-string `secret` doesn't byte-match.
     - (b) Body shape Zod-validated; reject malformed payloads with 400.
   - **Termii payload shape** (per their docs):
     ```json
     {
       "id": "<message_id>",
       "from": "+221770000000",
       "to": "<sender_id>",
       "text": "STOP",
       "received_at": "2026-04-28T10:00:00Z",
       ...
     }
     ```
   - **Logic:**
     1. Validate the `?secret=...` query param. If missing/wrong → 401 RFC 7807 (use `auth_unauthenticated` problem key from `_shared/rfc7807.ts`).
     2. Parse body. Validate it has `from` (phone string) and `text` (string). 400 if not.
     3. **Trim + uppercase `text`**; check it equals `STOP` exactly (or starts with `STOP` followed by whitespace — saver might type `STOP MERCI`). Other content → 200 with `{ ignored: true, reason: 'not_stop_keyword' }` (we don't want to leak that the system is recording inbound).
     4. Look up the member: hash the phone via `vault_decrypt` reverse — actually **reverse vault lookup is not feasible** (Vault hashes on encrypt). Alternative: query all members WHERE `vault_decrypt(phone_number_encrypted) = <inbound phone>`. This is O(N) over members but acceptable for the inbound webhook (low frequency; Termii rate-limited; member count bounded).
     5. **Wrinkle**: a phone may appear under multiple collectors. Set opt-out on **every** match (multi-collector saver opts out everywhere).
     6. For each match, call `set_member_sms_opt_out(p_member_id, 'stop_keyword')` via service-role.
     7. Return 200 `{ opted_out: <count> }` (no PII leak — count only).
   - **Logging:** structured JSON; phone hashed via SHA-256 prefix (mirrors Story 6.1 / 6.2 pattern); never plaintext.
   - **No re-auth required** — this is a system-to-system call from Termii.

6. **Receipt-url Worker — `POST /r/{token}/opt-out` endpoint.** Update `workers/receipt-url/src/index.ts`:
   - Add a new route `POST /r/{token}/opt-out` (mirrors the existing `/dispute` route layout from Story 6.4).
   - **Validate token regex** before any Supabase round trip (defence in depth — same as the GET path).
   - **Look up the transaction** to get `member_id` via the existing `get_receipt_payload` RPC OR a new lighter helper `get_member_id_from_token(p_token)`. **Decision:** add a NEW SECURITY DEFINER helper `get_member_id_from_token(p_token text) RETURNS uuid` (returns NULL if undone or unknown) — `get_receipt_payload` returns the full receipt payload which is overkill for the opt-out path. Migration `20260501000005_get_member_id_from_token.sql`.
   - Call `set_member_sms_opt_out(member_id, 'receipt_url')` via service-role.
   - Render a confirmation HTML page: *"Vous ne recevrez plus de SMS de SafariCash. Cette décision est traçable et réversible — contactez votre collecteur pour reprendre les notifications."* — a new `renderOptOutConfirmedHtml(token)` export from `render.ts`.
   - **GET /r/{token}/opt-out** (no POST yet) → renders an opt-out confirmation form: a single submit button. The page works without JS: form submits via standard HTML POST.
   - Method gate: only `GET` and `POST` allowed; other → 405.
   - Security headers identical to Story 6.4 (Cache-Control: private, no-store, etc.).
   - **No CSRF token** — the form is a single-button confirmation; the saver clicked the link from their own SMS. Worst-case CSRF attacker forces opt-out on a saver they target, which is functionally equivalent to that saver's own opt-out (no security loss; the saver can re-opt-in via the collector). MVP-acceptable per FR32 trust model.

7. **Receipt page render — opt-out link.** Update `workers/receipt-url/src/render.ts`'s `renderReceiptHtml`:
   - Below the dispute CTA section, add a SECONDARY link: `<a href="/r/{token}/opt-out">Ne plus recevoir de SMS</a>` styled subtly (smaller text, muted colour, no destructive tint — this is a calm choice, not a panic action).
   - Below the link: small note *"Votre opt-out est traçable et peut être annulé via votre collecteur."* (UX-spec line 122 — *"saver-side opt-out (FR32). The UX must confirm respect without shame, and must clearly explain the traceability trade-off."*).

8. **Idempotency.** Both opt-out paths MUST be idempotent — calling `set_member_sms_opt_out` twice for the same member emits exactly one `sms.opt_out` audit event (the RPC's `if v_already then return; end if;` guard). The receipt URL opt-out form also returns the same confirmation page on a second submission; no error.

9. **Existing queued SMS cancellation.** When `set_member_sms_opt_out` fires, any `sms_queue` rows still in `status='queued'` for transactions belonging to that member are flipped to `status='abandoned'` with `abandoned_at = now()`. **No audit event for the cancellation** — the `sms.opt_out` event is the user-visible signal; cancelling individual queued rows is a side-effect, not a separate user action. Mirrors the Story 4.5 undo_transaction cancellation pattern.

10. **`enqueue_sms_on_transaction` re-check.** Story 6.5's trigger replacement (AC #2) runs the `sms_opt_out` check AFTER the existing `kind in (...)` check but BEFORE the phone decrypt. Sequencing:
    1. `kind not in ('contribution', 'rattrapage', 'advance')` → return null (unchanged).
    2. Look up `members.sms_opt_out` (NEW). If true → return null.
    3. Decrypt phone (unchanged).
    4. Phone empty → return null (unchanged).
    5. Pick template_key + INSERT row (unchanged).

11. **Audit chain integrity.** Migration 0045's allowlist extension adds ONLY `'sms.opt_out'`. Diff vs Story 6.2's baseline migration 0037 should be 1 allowlist line + 1 comment. The canonical serialiser body remains byte-for-byte identical.

12. **Tests — schema migration contract (Deno).** Extend `_shared/sms-dispatch-trigger.contract.test.ts`:
    - **Case** — Set `sms_opt_out=true` for a seeded member; insert a contribution → assert NO sms_queue row inserted (the trigger short-circuits at AC #10 step 2).

13. **Tests — `set_member_sms_opt_out` RPC contract** (Deno). New `supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts`:
    - **Case 1** — Happy path: call RPC for a non-opted-out member; member.sms_opt_out flips to true, sms_opt_out_at populated, sms_opt_out_via='stop_keyword'; one `sms.opt_out` audit event lands.
    - **Case 2** — Idempotency: call RPC TWICE for the same member; second call is a no-op; only ONE audit event in audit_log.
    - **Case 3** — Cancels queued SMS: pre-seed a queued sms_queue row for the member's transaction; call RPC; assert the row's status is 'abandoned'.
    - **Case 4** — Already-sent / failed / abandoned rows are NOT touched (only `status='queued'` rows flip).
    - **Case 5** — Invalid `p_via` value → 22000.
    - **Case 6** — Unknown member_id → P0002.

14. **Tests — `audit_append_external` allowlist regression** (Deno). Extend `_shared/sms-worker-audit-allowlist.contract.test.ts`:
    - Add a **case** asserting `audit_append_external('sms.opt_out', ...)` is accepted.
    - Existing 'sms.delivered'-rejected case still passes (still NOT in allowlist).

15. **Tests — Termii inbound webhook contract** (Deno). New `supabase/functions/sms-inbound/index.test.ts`:
    - **Case 1** — Missing `?secret` query param → 401.
    - **Case 2** — Wrong `?secret` value → 401.
    - **Case 3** — Method GET → 405.
    - **Case 4** — Body missing `from` → 400.
    - **Case 5** — Body `text='hello'` (not STOP) → 200 + `{ ignored: true }`; member.sms_opt_out unchanged.
    - **Case 6** — Body `text='STOP'`, phone matches a seeded member → 200 + `{ opted_out: 1 }`; member.sms_opt_out=true; one `sms.opt_out` audit event.
    - **Case 7** — Body `text='stop merci'` (lowercase + extra) → matches the STOP prefix → opted out.
    - **Case 8** — Body `text='STOP'`, phone matches multiple members across two collectors → 200 + `{ opted_out: 2 }`; both members opted out.
    - **Case 9** — Body `text='STOP'`, phone has no member match → 200 + `{ opted_out: 0 }`.

16. **Tests — receipt-url Worker opt-out** (Playwright). Extend `tests/e2e/receipt-url-worker.spec.ts`:
    - **Case** — Seed a member + transaction; capture token. POST `/r/{token}/opt-out` → 200 + confirmation HTML. Verify `members.sms_opt_out=true`. Subsequent record_contribution for same member → trigger short-circuits, no sms_queue row.
    - **Case** — Token regex defence: malformed token → 404 even on the opt-out path.

17. **Tests — render unit** (vitest). Extend `workers/receipt-url/src/render.test.ts`:
    - Receipt HTML now contains the opt-out link `<a href="/r/{token}/opt-out">`.
    - Receipt HTML contains the traceability note.
    - New `renderOptOutConfirmedHtml(token)` test: contains the confirmation copy + back-link.

18. **CI workflow update.**
    - Add the new `sms-inbound` Edge Function. The local stack auto-discovers `supabase/functions/sms-inbound/`; CI's `supabase start` picks it up on the next run (no workflow change needed for that).
    - Add `TERMII_INBOUND_SECRET=ci-test-secret` to the Edge Function tests env block (line 191 of ci.yml — alongside `TERMII_API_KEY`).

19. **No new dependencies.** `sms-inbound` uses the existing `_shared/rfc7807.ts`, `_shared/auth-check.ts`, `_shared/test-fixtures.ts`. Worker opt-out endpoint reuses the existing service-role POST pattern from Story 6.4.

20. **`run-edge-tests.sh` wires** the 2 new Deno test paths:
    - `supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts`
    - `supabase/functions/sms-inbound/index.test.ts`

21. **All gates green.**
    - `npm run db:migrate` — applies 5 new migrations.
    - `npm run db:types --local` — regenerates types so `members.sms_opt_out` lands.
    - `npm run typecheck` / `lint` / `test` (vitest, with the new render assertions) / `test:edge` / `build` — all green.
    - `npx playwright test tests/e2e/receipt-url-worker.spec.ts` — the new opt-out cases pass.

## Tasks / Subtasks

- [x] **Task 1 — Migration 0044: `members.sms_opt_out` columns + partial index** (AC: #1)
- [x] **Task 2 — Migration 0045: trigger replacement (real opt-out check)** (AC: #2, #10) — diff vs Story 6.3 baseline is the new SELECT + IF block (~7 lines).
- [x] **Task 3 — Migration 0046: audit allowlist extension** (AC: #3, #11) — 1 allowlist line + comment-line diff vs Story 6.2 baseline.
- [x] **Task 4 — Migration 0047: `set_member_sms_opt_out` RPC** (AC: #4, #8, #9) — idempotent + cancels in-flight queued sms_queue rows + emits sms.opt_out audit via 5-arg overload.
- [x] **Task 5 — Migration 0048 + 0049: `get_member_id_from_token` + `find_members_by_phone` RPCs** (AC: #6) — `find_members_by_phone` not in spec but required for the inbound webhook's reverse lookup (vault has no reverse index). Documented as "in spec via AC #5 prose".
- [x] **Task 6 — Termii inbound Edge Function** (AC: #5)
  - `supabase/functions/sms-inbound/index.ts` — POST-only, `?secret=` query-string gate (constant-time compare), STOP keyword case-insensitive prefix match, multi-collector opt-out via `find_members_by_phone` RPC.
- [x] **Task 7 — Receipt-url Worker opt-out routes** (AC: #6, #7)
  - GET `/r/{token}/opt-out` renders no-JS POST form; POST flips opt-out via service-role + renders confirmation.
  - `renderReceiptHtml` adds the calm secondary link below the dispute CTA + traceability note.
- [x] **Task 8 — Trigger contract regression** (AC: #12) — 1 new case in `_shared/sms-dispatch-trigger.contract.test.ts`.
- [x] **Task 9 — `set_member_sms_opt_out` contract tests** (AC: #13) — 6/6 cases green.
- [x] **Task 10 — Audit-allowlist regression** (AC: #14) — extended the existing for-loop to include `'sms.opt_out'`.
- [x] **Task 11 — Termii inbound contract tests** (AC: #15) — 9/9 cases green.
- [x] **Task 12 — Playwright Worker opt-out** (AC: #16) — 2 new cases in `tests/e2e/receipt-url-worker.spec.ts`.
- [x] **Task 13 — Render unit tests** (AC: #17) — 3 new exports / 1 modified existing test; 36/36 vitest cases green incl. jest-axe.
- [x] **Task 14 — Wire test paths in `run-edge-tests.sh`** (AC: #20) — 2 new paths + `TERMII_INBOUND_SECRET` env default.
- [x] **Task 15 — CI env update** (AC: #18) — `TERMII_INBOUND_SECRET=ci-test-inbound-secret` added to the Edge Function tests env block.
- [x] **Task 16 — Verify all gates green** (AC: #21)
  - `npm run typecheck` ✅
  - `npm run lint` ✅ (after refactor: `postInbound` helper hoisted out of the `if (env)` block to satisfy `no-inner-declarations`)
  - `npm run test` ✅ — 584 vitest pass
  - `npm run test:edge` ✅ — 121 edge tests pass / 19 ignored / 0 failed
  - `npm run build` ✅
  - `npm run db:types --local` re-run; new columns + RPCs land in the typed surface (12 references).
  - **Local-dev caveat:** `supabase functions serve` requires `--env-file` to expose `TERMII_INBOUND_SECRET` to the runtime; without it, the function returns 500 with `{ event: "sms_inbound.secret_unset" }`.

## Dev Notes

### Architecture intelligence

- **prd.md:517 (FR31)** — *"The system delivers a data-protection consent notice on the saver's first SMS receipt, with a plain-language opt-out mechanism."*
- **prd.md:518 (FR32)** — *"A saver who has opted out of receipts no longer receives SMS for subsequent transactions; the opt-out is recorded in the audit trail."*
- **ux-design-specification.md:122** — *"Saver-side opt-out (FR32). The UX must confirm respect without shame, and must clearly explain the traceability trade-off."* — drives the calm copy + traceability note in AC #7.
- **architecture.md:99** — Termii is called from Edge Functions for SMS delivery. Inbound webhooks ALSO route through Edge Functions (this story adds the second — the OTP path was Story 1.3, decommissioned in 1.5b).

### Story 6.1 / 6.2 / 6.3 handshake — what's already in place

- Story 6.1 trigger placeholder `IF FALSE THEN ... END IF` is the structural slot Story 6.5 fills in with the real check (AC #2).
- Story 6.2 `audit_append_external` 5-arg overload is what `set_member_sms_opt_out` calls to emit the audit (AC #4).
- Story 6.3 `format_sms_body('first_receipt', ...)` already includes *"Repondez STOP pour ne plus recevoir."* (the user-visible instruction). Story 6.5 wires the action.
- Story 6.4 receipt-url Worker provides the surface for the receipt-URL opt-out path; Story 6.5 adds the route + render variants without restructuring.

### Termii inbound webhook security

- Operator setup: Termii dashboard → webhook URL = `https://safaricash.app/functions/v1/sms-inbound?secret=<random-32-char-secret>`. Set the same value in `wrangler secret put TERMII_INBOUND_SECRET` for local + production.
- The `?secret=` query-string approach is OPSEC-acceptable but NOT cryptographic-replay-proof. A future Story 6.X can upgrade to HMAC-signed-body verification once Termii v4 ships proper signature support.
- The webhook URL is logged by Cloudflare/Supabase; the `?secret=` will appear in access logs. **Operator note**: rotate quarterly; treat as a moderate-sensitivity secret.

### Multi-collector saver edge case

- A saver's phone might appear in multiple collector member lists (e.g., collector A imports their contact list; collector B independently does the same). Setting opt-out via STOP keyword fires for ALL matching members across collectors — the saver's intent is to stop ALL SafariCash SMS to that number, regardless of which collector "owns" the row.
- Receipt-URL opt-out fires only for the SPECIFIC member tied to the token. **Reasoning**: the URL is per-transaction; the saver's intent on this surface is contextually bound to the collector who issued that transaction.

### Idempotency + cancellation pattern

- The RPC's `if v_already then return; end if;` guard ensures double-clicks / double-replies don't fork the audit chain. Mirrors the Story 4.5 `already_undone` guard.
- The cancellation pattern (`UPDATE sms_queue SET status='abandoned' WHERE status='queued'`) mirrors `undo_transaction` — limited to in-flight rows; sent/failed/abandoned rows are immutable.

### Project structure notes

- Source tree:
  - NEW: `supabase/migrations/20260501000001_add_sms_opt_out_to_members.sql`
  - NEW: `supabase/migrations/20260501000002_enqueue_sms_optout_check.sql`
  - NEW: `supabase/migrations/20260501000003_audit_append_external_extend_optout.sql`
  - NEW: `supabase/migrations/20260501000004_set_member_sms_opt_out.sql`
  - NEW: `supabase/migrations/20260501000005_get_member_id_from_token.sql`
  - NEW: `supabase/functions/sms-inbound/index.ts`
  - NEW: `supabase/functions/sms-inbound/index.test.ts`
  - NEW: `supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts`
  - MODIFIED: `supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts` (1 new case)
  - MODIFIED: `supabase/functions/_shared/sms-worker-audit-allowlist.contract.test.ts` (1 new accepted-types case)
  - MODIFIED: `workers/receipt-url/src/index.ts` (2 new routes)
  - MODIFIED: `workers/receipt-url/src/render.ts` (3 new exports / 1 modified)
  - MODIFIED: `workers/receipt-url/src/render.test.ts` (3 new cases)
  - MODIFIED: `tests/e2e/receipt-url-worker.spec.ts` (2 new cases)
  - MODIFIED: `scripts/run-edge-tests.sh` (2 new test paths)
  - MODIFIED: `.github/workflows/ci.yml` (TERMII_INBOUND_SECRET env)
  - MODIFIED: `src/infrastructure/supabase/database.types.ts` (re-generated)
  - MODIFIED: `_bmad-output/implementation-artifacts/sprint-status.yaml`
- All paths align with architecture.md § Source Tree.
- No conflicts with prior stories.

### Testing standards

- Edge Function tests: Deno + `jsr:@std/assert@1`, reusing `_shared/test-fixtures.ts`.
- Render module tests: vitest + jest-axe (mirrors Story 6.4 pattern).
- Playwright E2E: extends the existing `receipt-url-worker.spec.ts` with the opt-out flow.
- Coverage: 100% on the new RPC body (6 cases cover all branches); render module's new exports gain jest-axe assertions.

### References

- [Source: epics.md#Story 6.5] — BDD acceptance criteria.
- [Source: prd.md#FR31 / FR32] — consent + opt-out functional requirements.
- [Source: ux-design-specification.md:122] — saver-side opt-out as a UX trust ceremony.
- [Source: supabase/migrations/20260427000005_audit_append_external.sql] — canonical-serialiser baseline.
- [Source: supabase/migrations/20260428000001_audit_append_external_extend_sms_events.sql] — Story 6.2's allowlist extension pattern (mirror for this story).
- [Source: supabase/migrations/20260429000003_enqueue_sms_format_body.sql] — Story 6.3's trigger; this story replaces the IF FALSE placeholder.
- [Source: supabase/migrations/20260426000004_undo_transaction.sql] — sms_queue cancellation pattern Story 6.5 mirrors.
- [Source: workers/receipt-url/src/index.ts] — Story 6.4 Worker; Story 6.5 adds 2 new routes without restructuring.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

### Completion Notes List

- 6 migrations: members.sms_opt_out columns + partial idx; trigger replacement (7-line diff vs Story 6.3); audit allowlist 1-line extension; set_member_sms_opt_out RPC; get_member_id_from_token RPC; find_members_by_phone RPC (added beyond spec — required for the inbound webhook's reverse-vault lookup).
- TWO opt-out paths fully wired:
  - sms-inbound Edge Function with `?secret=` query-string gate (constant-time compare). STOP keyword detection is prefix-match (handles "STOP merci", "stop", etc.). Multi-collector saver opts out across all matching members.
  - Receipt-URL Worker GET/POST `/r/{token}/opt-out` routes. POST flips opt-out via service-role + renders confirmation HTML.
- Idempotency proven: 6 RPC contract cases incl. duplicate-call no-op + cancellation pattern + already-sent-row preservation.
- Receipt page (Story 6.4 surface) gets a calm secondary opt-out link below the dispute CTA + traceability note (UX-spec line 122).
- All gates green: typecheck / lint / 584 vitest / 121 edge tests / build.

### File List

**New migrations:**
- `supabase/migrations/20260501000001_add_sms_opt_out_to_members.sql`
- `supabase/migrations/20260501000002_enqueue_sms_optout_check.sql`
- `supabase/migrations/20260501000003_audit_append_external_extend_optout.sql`
- `supabase/migrations/20260501000004_set_member_sms_opt_out.sql`
- `supabase/migrations/20260501000005_get_member_id_from_token.sql`
- `supabase/migrations/20260501000006_find_members_by_phone.sql`

**New Edge Function:**
- `supabase/functions/sms-inbound/index.ts`
- `supabase/functions/sms-inbound/index.test.ts`

**New contract test:**
- `supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts`

**Modified:**
- `supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts` (1 new opt-out short-circuit case)
- `supabase/functions/_shared/sms-worker-audit-allowlist.contract.test.ts` (extended loop with `'sms.opt_out'`)
- `workers/receipt-url/src/index.ts` (2 new routes + `supabaseRpc` helper + `setMemberSmsOptOut`/`fetchMemberIdFromToken`)
- `workers/receipt-url/src/render.ts` (added `renderOptOutFormHtml` + `renderOptOutConfirmedHtml`; updated `renderReceiptHtml` with opt-out link + traceability note)
- `workers/receipt-url/src/render.test.ts` (3 new test groups)
- `workers/receipt-url/tsconfig.json` (excluded `*.test.ts` from the Worker tsconfig — they run via vitest with jsdom env)
- `tests/e2e/receipt-url-worker.spec.ts` (2 new opt-out cases)
- `scripts/run-edge-tests.sh` (2 new test paths + `TERMII_INBOUND_SECRET` default)
- `.github/workflows/ci.yml` (TERMII_INBOUND_SECRET env on the Edge Function tests step)
- `src/infrastructure/supabase/database.types.ts` (re-generated — new columns + 4 new RPCs)
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
