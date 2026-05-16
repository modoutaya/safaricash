# Story 10.1: DisputeFlagSurface on the receipt URL page

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **saver**,
I want **to tap "Cette transaction n'est pas moi" on my receipt URL page and confirm a dispute**,
so that **I can signal a problem with a transaction without needing an account or app (FR33b, UX-DR11).**

> **Predicate of this story. FIRST story of Epic 10 (Saver Dispute Flow & Data Rights).** Epic 10 extends Epic 6's receipt-URL surface with the saver dispute path + data-rights actions, without touching the core receipt flow.
>
> **What 10.1 ships — the saver-facing dispute capture, end to end:**
> 1. **The confirmation page.** `GET /r/{token}/dispute` (currently a 501 stub) renders a real server-side confirmation page — a destructive-tinted "sheet" with an optional free-text input and two CTAs: **"Signaler"** (destructive, the POST submit) / **"Annuler"** (a link back to `/r/{token}`).
> 2. **The dispute submission.** `POST /r/{token}/dispute` (currently a 501 stub) validates the token, calls a new `SECURITY DEFINER` RPC that inserts a `public.disputes` row + emits a `dispute.flagged` audit event, then renders a **compassionate acknowledgment screen**.
> 3. **The DB plumbing.** One migration: a `flag_transaction_dispute` RPC (token → transaction + collector, idempotent insert) + an `audit_disputes` trigger so the INSERT hash-chains a `dispute.flagged` event into `audit_log`.
>
> **The receipt-page CTA already exists.** Story 6.4 already shipped, on the main receipt page (`render.ts`), the `<section class="dispute">` with the **"Cette transaction n'est pas moi"** link → `/r/{token}/dispute` AND the reversibility note. 10.1 does NOT rebuild them — AC #1 only verifies they are present and correct. 10.1 replaces the 501 stub *behind* that link.
>
> **No JavaScript. Server-rendered.** The receipt Worker emits a single self-contained HTML document per request — plain template-literal HTML, an inline `<style>` block, ZERO `<script>` (UX-DR19, enforced by a render unit test). The "bottom-sheet" the UX spec describes is realised as a server-rendered confirmation *page* (the GET `/dispute` route) — the no-JS architecture mandate overrides the literal "modal" wording; the UX spec itself flags the surface as "progressive enhancement … no JavaScript required". "Annuler" is an `<a>`; "Signaler" is a `<form method="post">` submit.
>
> **Code-reuse map (DO NOT re-invent):**
> - **Worker routing** — `workers/receipt-url/src/index.ts` ALREADY matches `/^\/r\/([^/]+)(?:\/(dispute|opt-out))?$/` and dispatches `GET → disputeGet`, `POST → disputePost`. The token is ALREADY validated (`tokenIsValid`) before dispatch. 10.1 replaces the handler bodies in `workers/receipt-url/src/dispute.ts` and threads `env` (and `token`) into them at the two call sites in `index.ts`.
> - **Worker → Supabase** — the `supabaseRpc<T>(env, rpcName, args)` helper in `index.ts` (service-role key: `env.SUPABASE_SERVICE_ROLE_KEY` + `env.SUPABASE_PROJECT_URL`, a `fetch` POST to `/rest/v1/rpc/{name}`). Reuse it; do NOT add a Supabase JS client.
> - **HTML rendering** — `workers/receipt-url/src/render.ts` — template-literal strings, `htmlShell(title, body)`, `escapeHtml(...)`, the shared inline `STYLE_BLOCK` (already has a `.dispute` class). Add the new render functions here.
> - **`disputes` table** — already exists (`20260419000001_init_schema.sql`): `id, collector_id, transaction_id, flagged_at, flagged_via, status, notes, resolved_at`. Enums: `disputes_via_enum (receipt_url|support_email|support_phone)`, `disputes_status_enum (open|resolved|dismissed)`. Defaults: `flagged_via='receipt_url'`, `status='open'`, `flagged_at=now()`. DO NOT alter the table.
> - **Token → transaction** — `transactions.receipt_token` (32 hex chars, unique index, Story 6.3). The receipt-payload RPC `get_receipt_payload(p_token)` already resolves a token; the dispute RPC does its own `WHERE receipt_token = p_token AND undone_at IS NULL` lookup.
> - **Audit** — `audit_emit()` (`20260419000007_triggers_audit.sql`) is the canonical hash-chain serialiser, fired by `audit_members` / `audit_cycles` / `audit_transactions` triggers. 10.1 extends it for `disputes`.
>
> **What Story 10.1 does NOT ship (later Epic-10 stories):**
> - The `dispute-notify` Edge Function — collector in-app/Realtime alert + founder email/push (**Story 10.2**).
> - The dispute acknowledgment SMS to the saver (**Story 10.2** — `format_sms_body('dispute_ack', …)`).
> - The collector-side in-app dispute banner on the member profile + the history dispute icon + manual resolution (**Story 10.3**).
> - Saver anonymisation / right-to-deletion (**Story 10.4**); the receipt-URL opt-out action (**Story 10.5**).
> - Automated dispute adjudication (Growth).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1329-1339`; the rest are spec-derived constraints.

### The receipt-page CTA (already shipped — verify)

1. **Given** a valid receipt URL page (`GET /r/{token}`), **Then** below the transaction details a destructive-tinted `<section class="dispute">` shows the button/link **"Cette transaction n'est pas moi"** linking to `/r/{token}/dispute`, **And** below it the reversibility note **"Appuyé par erreur ? Vous pourrez annuler dans les 24h."** — these were built by Story 6.4; 10.1 verifies they render unchanged and the existing receipt render test still passes.

### The dispute confirmation page — `GET /r/{token}/dispute`

2. **Given** the saver taps the receipt-page CTA, **When** `GET /r/{token}/dispute` is requested with a structurally valid token, **Then** the Worker returns **200** with a server-rendered HTML confirmation page (replacing the current 501 "coming soon" stub).

3. **The confirmation page anatomy.** It shows: a heading; a one-line compassionate framing; an optional free-text `<textarea name="notes">` labelled **"Dites-nous ce qui s'est passé (optionnel)"**; a destructive-styled submit button **"Signaler"** inside a `<form method="post" action="/r/{token}/dispute">`; and an **"Annuler"** `<a href="/r/{token}">` link. Destructive styling reuses the dispute palette (`#FAECE7` background / `#712B13` text).

4. **No JavaScript.** The page contains NO `<script>` tag. Interactivity is the native `<form>` POST + the `<a>` link. Self-contained HTML + the shared inline `STYLE_BLOCK`.

5. **Invalid token on the dispute route** → the existing `notFoundHtml()` 404 path (token validation already runs in `index.ts` before dispatch — keep that behaviour).

### The dispute submission — `POST /r/{token}/dispute`

6. **Given** the saver submits the form, **When** `POST /r/{token}/dispute` is received, **Then** the Worker reads the optional `notes` field from the `application/x-www-form-urlencoded` body, calls the new `flag_transaction_dispute` RPC via `supabaseRpc`, and branches on its result.

7. **On a successful new dispute** → the Worker returns **200** with a **compassionate acknowledgment screen**: **"Merci. Votre signalement a été transmis au collecteur et à SafariCash. Nous vous recontacterons sous 48h via SMS."** — rendered with the trust/green palette (`#E1F5EE` / `#085041`), NOT red. No accusatory language.

8. **The dispute row.** A successful submission inserts exactly one `public.disputes` row: `transaction_id` + `collector_id` resolved from the token, `flagged_via='receipt_url'`, `status='open'`, `notes` = the trimmed free-text or `NULL` when empty/blank.

9. **Idempotency / already-disputed.** If an `open` dispute already exists for that transaction, the RPC does NOT insert a second row and returns an `already_disputed` result; the Worker renders an acknowledgment variant **"Signalement déjà envoyé. Réponse sous 48 h."** (still 200, not an error).

10. **Token not resolvable** (no non-undone transaction for the token) → the RPC returns a `not_found` result → the Worker returns the `notFoundHtml()` 404 page. (Structurally invalid tokens are already rejected upstream per AC #5.)

11. **`notes` length guard.** The free-text is capped (e.g. 500 chars) — the Worker truncates or the RPC clamps; an over-long body must not error. The text is stored as-is into `disputes.notes` (a plain `text` column); HTML-escape it wherever it is echoed back into a page.

### Audit trail

12. **Given** a `disputes` row is inserted, **Then** a `dispute.flagged` audit event is hash-chained into `audit_log` for that collector — `entity_table='disputes'`, `entity_id` = the new dispute id, chained via the canonical `audit_emit()` serialiser.

13. **Migration — audit plumbing.** Extend `audit_emit()` with a `disputes` + `INSERT` → `'dispute.flagged'` CASE branch; add an `audit_disputes` AFTER INSERT trigger (mirroring `audit_members` / `audit_cycles` / `audit_transactions`); extend the `audit_log.event_type` CHECK constraint to admit `'dispute.flagged'`. Verify `audit_emit` derives `collector_id` / `entity_id` correctly for a `disputes` NEW row (the table has both `collector_id` and `id`).

14. **Migration — the dispute RPC.** A `SECURITY DEFINER` function `flag_transaction_dispute(p_receipt_token text, p_notes text)` (search_path-pinned, `GRANT EXECUTE` to `service_role`, `REVOKE` from `public`): resolves the transaction (`WHERE receipt_token = p_receipt_token AND undone_at IS NULL`); on no row → returns `not_found`; checks for an existing `open` dispute on that `transaction_id` → returns `already_disputed`; else inserts the `disputes` row (the trigger emits the audit event) → returns `created`. The RPC must NOT depend on `auth.uid()` (the Worker calls under the service-role key with no JWT sub — `auth.uid()` is `NULL`).

### Architecture, hygiene, tests

15. **No new dependencies** — neither in `workers/receipt-url/` nor in the root. Web-standard `fetch` + `URLSearchParams` (form-body parsing) + template literals only. No Supabase JS client, no framework.

16. **Worker structure.** Handler logic in `workers/receipt-url/src/dispute.ts` (replace the two 501 stubs); HTML in `render.ts` (new exported render functions, reuse `htmlShell` + `escapeHtml` + `STYLE_BLOCK`); `index.ts` threads `env` into `disputeGet`/`disputePost` and `token` into `disputePost` at the existing call sites — no routing-regex change.

17. **`migrate` not `reset`.** New migration via `npm run db:migrate:new`; apply with `npm run db:migrate`. The migration touches an RPC body + a trigger — `psql`-smoke-test it before push (`feedback_migration_rpc_smoke_test.md`): assert a `flag_transaction_dispute` call inserts a row + chains a `dispute.flagged` audit row, a second call returns `already_disputed`, a bogus token returns `not_found`.

18. **Unit tests (vitest, in `workers/receipt-url/src/`).** `dispute.test.ts` — new: GET renders the form (200, no `<script>`, the three copy strings, the form `action`/`method`); POST success → acknowledgment copy; POST already-disputed → "déjà envoyé" copy; POST not-found → 404; `notes` parsed from the form body; over-long `notes` handled. `render.test.ts` — extend: the new render functions are `axe`-clean and contain no `<script>`. Mock the `supabaseRpc` / `fetch` boundary.

19. **E2E (Playwright) — `tests/e2e/receipt-url-worker.spec.ts`.** The existing assertions #6/#7 assert the 501 stubs ("Cette fonctionnalité arrive bientôt" / "Story 10.2") — REPLACE them: `GET /r/{token}/dispute` → 200 + the form copy; `POST` with a `notes` body → 200 + the acknowledgment copy; assert a `disputes` row + a `dispute.flagged` `audit_log` row landed (service-role client); a second POST → 200 + the "déjà envoyé" copy + still exactly one `disputes` row. The Worker runs on `:8788` (`npm run worker:receipt-url:dev`).

20. **All gates green** (Node 22 / npm 10): `npm run typecheck`; `npm run lint --max-warnings=0`; `npm run test -- --coverage` (global ≥ 75% branches); `npm run build`; `npm run test:edge` (no Deno change expected — confirm still green); the receipt-URL Worker unit tests; `npx playwright test` — the updated `receipt-url-worker` flow + full suite locally. Pre-push: `nvm use 22`, coverage locally, grep stale assertions, `psql` smoke-test the migration.

## Tasks / Subtasks

- [x] **Task 1 — Migration: audit plumbing for `disputes`** (AC: #12, #13)
  - `npm run db:migrate:new dispute-flag-audit-and-rpc`.
  - Extend `audit_emit()` (`CREATE OR REPLACE`) with `when v_entity_table = 'disputes' and v_op = 'INSERT' then 'dispute.flagged'`.
  - Add `create trigger audit_disputes after insert on public.disputes for each row execute function public.audit_emit();`.
  - Extend the `audit_log.event_type` CHECK constraint to admit `'dispute.flagged'` (drop + re-add, or whatever pattern the existing constraint uses — read `20260419000003_audit_log.sql`).
  - Verify `audit_emit` resolves `collector_id`/`entity_id` from a `disputes` NEW row.

- [x] **Task 2 — Migration: `flag_transaction_dispute` RPC** (AC: #8, #9, #10, #14)
  - Same migration file (or a second): `SECURITY DEFINER`, `set search_path`, args `(p_receipt_token text, p_notes text)`, returns a small result (e.g. a `text` status `created|already_disputed|not_found`, or a row with the dispute id).
  - Resolve transaction by `receipt_token` + `undone_at IS NULL`; idempotency check on an existing `open` dispute; insert; `GRANT EXECUTE … TO service_role` + `REVOKE … FROM public`.
  - `npm run db:migrate`; `psql` smoke-test (AC #17).

- [x] **Task 3 — Worker: the dispute confirmation page render** (AC: #2, #3, #4)
  - `render.ts` — add an exported `renderDisputeFormHtml(token)` (reuse `htmlShell`, `escapeHtml`, `STYLE_BLOCK`; destructive palette; the `<form>` + `<textarea>` + Signaler/Annuler; no `<script>`).

- [x] **Task 4 — Worker: the acknowledgment screens** (AC: #7, #9)
  - `render.ts` — `renderDisputeAcknowledgedHtml()` (compassionate, green palette) + the already-disputed variant ("Signalement déjà envoyé. Réponse sous 48 h.").

- [x] **Task 5 — Worker: `disputeGet` / `disputePost` handlers** (AC: #2, #5, #6, #7, #9, #10, #11)
  - `dispute.ts` — replace both 501 stubs. `disputeGet(token)` → `renderDisputeFormHtml`. `disputePost(token, request, env)` → parse the form body (`URLSearchParams`), clamp `notes`, call `flag_transaction_dispute` via `supabaseRpc`, branch `created`/`already_disputed`/`not_found` → the right render / 404.
  - `index.ts` — thread `env` into `disputeGet`/`disputePost` and `token` + `request` into `disputePost` at the existing dispatch lines.

- [x] **Task 6 — Worker unit tests** (AC: #18)
  - `dispute.test.ts` (new) + extend `render.test.ts`. Mock the `fetch`/`supabaseRpc` boundary.

- [x] **Task 7 — E2E + gate run + sprint hygiene** (AC: #19, #20)
  - Rewrite the `receipt-url-worker.spec.ts` dispute assertions (#6/#7) for the live flow; assert the `disputes` + `audit_log` rows.
  - All gates green on Node 22; full Playwright suite locally before push.
  - `sprint-status.yaml`: `10-1-dispute-flag-surface` `ready-for-dev → review`; `epic-10 → in-progress`; `last_updated` + touched line.

### Review Findings

> Cross-LLM adversarial review 2026-05-16 (claude-sonnet-4-6, 3 layers: Blind Hunter / Edge Case Hunter / Acceptance Auditor). 0 decision + 4 patch + 14 dismissed as noise. All 4 patches applied.

- [x] [Review][Patch] TOCTOU race in `flag_transaction_dispute` — FIXED: added the partial unique index `disputes_one_open_per_transaction ON disputes(transaction_id) WHERE status='open'` + an `exception when unique_violation then return 'already_disputed'` handler around the INSERT. psql-smoke-tested — a direct duplicate open-dispute INSERT now raises `unique_violation`, only one open dispute persists [supabase/migrations/20260516101216_dispute-flag-audit-and-rpc.sql]
- [x] [Review][Patch] `disputePost` now parses the body via `new URLSearchParams(await request.text())` instead of `request.formData()` — Content-Type-independent [workers/receipt-url/src/dispute.ts]
- [x] [Review][Patch] `dispute.test.ts` GET test now asserts all 3 copy strings incl. `"Dites-nous ce qui s'est passé"` (AC #18) [workers/receipt-url/src/dispute.test.ts]
- [x] [Review][Patch] added the `axe` assertion for `renderDisputeAlreadyFlaggedHtml` + the `Annuler` assertion in the E2E GET-form check [workers/receipt-url/src/render.test.ts, tests/e2e/receipt-url-worker.spec.ts]

## Dev Notes

### The receipt-URL Worker is a no-build, no-JS Cloudflare Worker

`workers/receipt-url/` has its own `tsconfig.json` + `wrangler.toml`, no `nodejs_compat`, Web-standard APIs only. HTML is template-literal strings; the only styling is the inline `STYLE_BLOCK` in `render.ts`. The render output must contain NO `<script>` — a render unit test asserts this (UX-DR19). The dispute "bottom-sheet" is therefore a server-rendered confirmation *page* at `GET /r/{token}/dispute`, not a JS modal. `wrangler.toml` already wires `SUPABASE_PROJECT_URL` (`[vars]`) + `SUPABASE_SERVICE_ROLE_KEY` (a `wrangler secret`, never in `[vars]`).

### The route is already wired — only the handler bodies are stubs

`index.ts` matches `/^\/r\/([^/]+)(?:\/(dispute|opt-out))?$/` and, for `subroute === "dispute"`, calls `disputeGet(rawToken)` / `disputePost()` — after `tokenIsValid(rawToken)`. `dispute.ts` currently returns 501 for both. 10.1 replaces the bodies and threads `env` (both) + `token` + `request` (POST) through. No routing-regex change.

### Why a `SECURITY DEFINER` RPC and not a direct PostgREST insert

`public.disputes` has RLS **forced**: `disputes_no_anon` hard-denies `anon`; `disputes_collector_isolation` is `authenticated`-only and gated on `collector_id = auth.uid()`. The Worker calls Supabase with the **service-role key and no user JWT** — `auth.uid()` is `NULL`. service_role bypasses RLS, so a `SECURITY DEFINER` RPC (granted to `service_role`) can insert freely; it must resolve `collector_id` from the token, NOT from `auth.uid()`. This is the same pattern as `get_receipt_payload` / `set_member_sms_opt_out` / `get_member_id_from_token`.

### Why the audit goes through `audit_emit` (a trigger), not `audit_append_external`

`audit_append_external` requires a non-null `auth.uid()` and raises `28000` otherwise — unusable from the Worker's service-role-no-JWT path. The clean, consistent path is the table-trigger `audit_emit()` that already hash-chains `members` / `cycles` / `transactions` mutations. Add a `disputes` CASE branch + an `audit_disputes` trigger + extend the `audit_log.event_type` CHECK — the plain `INSERT` into `disputes` then hash-chains `dispute.flagged` automatically with zero `auth.uid()` dependency.

### Exact French copy (verbatim — UX spec / `render.ts` baseline)

| Surface | String |
|---|---|
| Receipt-page CTA (already shipped) | `Cette transaction n'est pas moi` |
| Reversibility note (already shipped) | `Appuyé par erreur ? Vous pourrez annuler dans les 24h.` |
| Free-text placeholder/label | `Dites-nous ce qui s'est passé (optionnel)` |
| Confirm CTA | `Signaler` |
| Cancel CTA | `Annuler` |
| Acknowledgment screen | `Merci. Votre signalement a été transmis au collecteur et à SafariCash. Nous vous recontacterons sous 48h via SMS.` |
| Already-disputed | `Signalement déjà envoyé. Réponse sous 48 h.` |

### Design tokens

- Destructive / dispute: background `#FAECE7`, text `#712B13` (AAA contrast 9.1:1), active `#E24B4A`. The `.dispute` CSS class is already in `STYLE_BLOCK`.
- Acknowledgment (trust/green): background `#E1F5EE`, text `#085041`. Red is reserved for the *flag* surface; the *acknowledgment* must NOT be red.

### Anti-patterns to avoid

- **DO NOT** add a `<script>` to any Worker HTML output (UX-DR19 — render test enforces).
- **DO NOT** add an npm dependency (no Supabase JS client, no framework) — `fetch` + `URLSearchParams` + template literals.
- **DO NOT** insert into `disputes` via a direct anon PostgREST call — RLS denies it; use the `SECURITY DEFINER` RPC.
- **DO NOT** use `auth.uid()` in the dispute RPC — it is `NULL` under the Worker's service-role path; resolve `collector_id` from the token.
- **DO NOT** call `audit_append_external` from the RPC — use the `audit_emit` trigger path.
- **DO NOT** rebuild the receipt-page CTA / reversibility note — Story 6.4 already shipped them; only replace the 501 page behind the link.
- **DO NOT** dispatch the dispute SMS or notify the collector/founder — those are Story 10.2.
- **DO NOT** `npm run db:reset`; **DO NOT** `npm install` on Node 24 — `nvm use 22`.
- **DO NOT** push the migration without a `psql` smoke test (`feedback_migration_rpc_smoke_test.md`).

### Project structure notes

**New files:**
- `supabase/migrations/<timestamp>_dispute_flag_audit_and_rpc.sql`
- `workers/receipt-url/src/dispute.test.ts`

**Modified files:**
- `workers/receipt-url/src/dispute.ts` — replace the two 501 stubs.
- `workers/receipt-url/src/render.ts` — new dispute render functions (replaces the use of `renderComingSoonDisputeHtml`).
- `workers/receipt-url/src/index.ts` — thread `env`/`token`/`request` into the dispute dispatch.
- `workers/receipt-url/src/render.test.ts` — extend.
- `tests/e2e/receipt-url-worker.spec.ts` — rewrite the dispute assertions (#6/#7).
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

### Testing standards

- Worker unit tests: vitest, alongside source in `workers/receipt-url/src/`; `jest-axe` for the render a11y checks; mock the `fetch`/`supabaseRpc` boundary for the POST handler.
- Migration: `psql` smoke test (RPC insert + audit chain + idempotency + not-found).
- E2E: Playwright against the Worker on `:8788` + a service-role Supabase client to assert the `disputes` / `audit_log` rows.

### Definition-of-done checklist

- All 20 ACs satisfied + all 7 tasks ticked.
- `GET /r/{token}/dispute` renders the confirmation form; `POST` inserts a `disputes` row + chains a `dispute.flagged` audit event + renders the compassionate acknowledgment; a re-submit is idempotent.
- No `<script>` in any Worker output; no new dependency.
- All gates green on Node 22 / npm 10; migration `psql`-smoke-tested; full Playwright suite run locally.
- Story status `review`; sprint-status updated (`epic-10 → in-progress`); touched line updated.

## References

- **Epic spec:** `epics.md` lines 1319-1339 (Epic 10 + Story 10.1 BDD).
- **PRD:** `prd.md` — FR33b (saver dispute flag on the receipt URL page; records immutably in the audit trail; notifies collector + founder), line 153 (MVP non-negotiable scope), line 333 (collector-fraud risk mitigation).
- **UX spec:** `ux-design-specification.md` — lines 673-679 (the dispute-flag surface "gap to fill"), 827-861 (Flow 4 — Saver Dispute Flag), 1161-1191 (Surface Catalog — Dispute Flag Surface, states incl. "Already disputed"), 350/512/536 (destructive palette), 211 (red reserved for irreversible/dispute), UX-DR11 / UX-DR19 (no-JS).
- **Existing code:** `workers/receipt-url/src/{index,dispute,render,token}.ts` (the Worker — routing, the 501 dispute stubs, the renderer, token validation), `workers/receipt-url/wrangler.toml`, `tests/e2e/receipt-url-worker.spec.ts` (the E2E — assertions #6/#7 to rewrite), `supabase/migrations/20260419000001_init_schema.sql` (the `disputes` table + enums), `20260419000002_rls_policies.sql` (`disputes` RLS), `20260419000007_triggers_audit.sql` (`audit_emit` + the 3 audit triggers), `20260419000003_audit_log.sql` (the `audit_log` table + `event_type` CHECK), `20260429000001_add_receipt_token_to_transactions.sql` (`transactions.receipt_token`), `20260430000001_get_receipt_payload.sql` + `20260501000005_get_member_id_from_token.sql` (the existing token-resolution RPC pattern).
- **Story 6.4** (`6-4-receipt-url-worker.md`) — the receipt-URL Worker baseline: no-build, no-JS, inline-CSS, the deferred-501 dispute scaffold.
- **CLAUDE.md:** tokens not hex; `db:migrate` not `db:reset`; no new deps for trivial needs.
- **Memory:** `feedback_migration_rpc_smoke_test.md`, `feedback_npm_lockfile_node_version.md`, `feedback_run_coverage_locally.md`, `feedback_push_then_ci_failure.md`, `project_supabase_rpc_binding.md`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **`audit_emit` rebased on the WRONG baseline — caught by the E2E.** The migration's first draft reproduced `audit_emit()` from migration 0007 (the original). But `audit_emit` had since been patched three times: 0017 (Story 2.5 — the 3-tier actor-JWT fallback), 0020 (Story 3.3 — `cycle.transitioned`), 0030 (Story 4.5 — `transaction.undone`). The 0007-baseline `CREATE OR REPLACE` silently REVERTED all three. The full Playwright suite surfaced it: `flow-1-record-contribution` failed `expect(actor).toBe(<uuid>)` got `"system"` — the lost JWT fallback. Six seed-heavy flows failed identically. Fixed by rebasing the migration body on 0030 (the current version) + the one new `disputes` CASE line; re-applied to the local DB; all six flows then green. (Same class of mistake as Story 9.3's `audit_append_external` 0036-vs-0051 — when `CREATE OR REPLACE`-ing a function, always diff against the LATEST migration that touched it.)
- **`audit_log.event_type` CHECK needs no change.** AC #13 anticipated extending it, but it is a regex (`^[a-z][a-z_]*\.[a-z][a-z_]*$`), not an allowlist — `dispute.flagged` already passes.

### Completion Notes List

- **Migration `20260516101216`** — `audit_emit()` gains the `(disputes, INSERT) → 'dispute.flagged'` branch (body otherwise byte-identical to migration 0030); an `audit_disputes` AFTER INSERT trigger; the `flag_transaction_dispute(p_receipt_token, p_notes)` SECURITY DEFINER RPC (service_role-only, idempotent, resolves `collector_id` from the token — never `auth.uid()`). psql-smoke-tested: `created` / `already_disputed` / `not_found`, blank notes → NULL, exactly one row on re-submit, a chain-valid `dispute.flagged` audit row.
- **Worker** — `dispute.ts` replaces the two 501 stubs: `disputeGet` renders the no-JS confirmation form; `disputePost` parses the urlencoded body (clamps `notes` to 500 chars server-side), calls the RPC via a self-contained `fetch` (mirrors `setMemberSmsOptOut` — no circular import; `Env` is a type-only import), branches `created`→ack / `already_disputed`→"déjà envoyé" / `not_found`→404 / RPC-unreachable→500. `index.ts` threads `(rawToken, req, env)` into `disputePost`; `renderComingSoonDisputeHtml` removed.
- **`disputeGet` does not receive `env`** — the GET form is static (no DB read); only `disputePost` needs it.
- **No-JS preserved** — all dispute render output is `<script>`-free (render unit tests assert it); the "bottom-sheet" is a server-rendered page.
- **`test:edge`** — the 165 contract tests that exercise `audit_emit` (member/cycle/transaction inserts) all pass, confirming the migration. The 11 failures are exclusively `sms-inbound` / `sms-worker` tests failing with "Inbound webhook secret not configured" — the LOCAL Edge runtime lacks `TERMII_INBOUND_SECRET` / `TERMII_API_KEY` (a local-env config gap; CI provisions them). Story 10.1 adds no Deno test; the migration was validated via psql smoke test + the full Playwright suite.
- **Gates** (Node 22): typecheck ✓ · lint --max-warnings=0 ✓ · 961 vitest passed (incl. 68 worker tests) ✓ · branches 76.25% global ✓ · build ✓ · Playwright `receipt-url-worker` 10/10 incl. the new dispute flow ✓ · full Playwright 41 passed (1 local-only failure: `flow-3-cycle-settlement` re-auth — fails identically on clean `main`, passes in CI).
- **`.gitignore`** — added `**/.dev.vars` (wrangler local-secrets convention) so a local Edge-worker run can point at the local Supabase stack without committing a key.

### File List

**New:**
- `supabase/migrations/20260516101216_dispute-flag-audit-and-rpc.sql`
- `workers/receipt-url/src/dispute.test.ts`

**Modified:**
- `workers/receipt-url/src/dispute.ts` — the GET form + POST handler (replaced the 501 stubs).
- `workers/receipt-url/src/render.ts` — `renderDisputeFormHtml` / `renderDisputeAcknowledgedHtml` / `renderDisputeAlreadyFlaggedHtml` + dispute CSS; removed `renderComingSoonDisputeHtml`.
- `workers/receipt-url/src/index.ts` — thread `(rawToken, req, env)` into `disputePost`; route comment.
- `workers/receipt-url/src/render.test.ts` — dispute render tests (replaced the coming-soon block).
- `workers/receipt-url/README.md` — routes table + dispute-flow section.
- `tests/e2e/receipt-url-worker.spec.ts` — the live dispute-flow assertions (replaced the 501 assertions).
- `.gitignore` — `**/.dev.vars`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-16 | Story 10.1 drafted via bmad-create-story — FIRST story of Epic 10 (Saver Dispute Flow & Data Rights). The saver-facing dispute capture on the receipt-URL Cloudflare Worker: `GET /r/{token}/dispute` renders a server-side confirmation page (optional free-text + "Signaler"/"Annuler"); `POST /r/{token}/dispute` calls a new `SECURITY DEFINER` `flag_transaction_dispute` RPC that resolves the transaction + collector from the token, inserts a `public.disputes` row idempotently, and (via a new `audit_disputes` trigger + an `audit_emit` CASE branch) hash-chains a `dispute.flagged` audit event; the Worker then renders a compassionate acknowledgment screen. One migration: the audit plumbing + the RPC. The route + token validation + the receipt-page CTA already exist (Story 6.4); 10.1 replaces the 501 stubs behind the link. No JavaScript (server-rendered, UX-DR19), no new dependency. NOT in scope: the dispute-notify Edge Function + dispute SMS (10.2), the collector member-profile banner (10.3), anonymisation (10.4), opt-out (10.5). 20 ACs / 7 tasks. | Spec author (claude-opus-4-7[1m]) |
| 2026-05-16 | Cross-LLM code review (claude-sonnet-4-6, 3-layer adversarial) — 0 decision + 4 patch + 14 dismissed; all 4 patches applied. (1) HIGH: TOCTOU race in `flag_transaction_dispute` — added a partial unique index `disputes(transaction_id) WHERE status='open'` + a `unique_violation → already_disputed` exception handler (psql-smoke-tested). (2) `disputePost` parses the body via `URLSearchParams(await request.text())` not `request.formData()`. (3) GET test asserts all 3 copy strings. (4) added the `renderDisputeAlreadyFlaggedHtml` axe test + the E2E `Annuler` assertion. Gates re-run green: typecheck / lint / 962 vitest / receipt-url-worker E2E 10/10. The migration also correctly preserves the actor-JWT fallback + cycle.transitioned + transaction.undone branches (verified by the Edge Case Hunter). | Dev agent (claude-opus-4-7[1m]) |
| 2026-05-16 | Story 10.1 implemented via bmad-dev-story on `feat/10-1-dispute-flag-surface` — 7 tasks / 20 ACs. Migration `20260516101216`: `audit_emit` `(disputes, INSERT) → dispute.flagged` branch + `audit_disputes` trigger + the `flag_transaction_dispute` SECURITY DEFINER RPC (idempotent, token-resolved, service_role-only). Worker `dispute.ts` replaces the 501 stubs with the no-JS confirmation form (`disputeGet`) + the dispute-recording POST handler (`disputePost`); `render.ts` gains the dispute form / acknowledgment / already-flagged render functions. Debug: the first migration draft rebased `audit_emit` on the stale 0007 baseline, reverting the Story 2.5/3.3/4.5 patches — caught by the full Playwright suite (`actor` = "system"), fixed by rebasing on 0030. Gates green: typecheck / lint / 961 vitest / build / Playwright `receipt-url-worker` 10/10 + full suite 41 passed (1 local-only `flow-3` re-auth failure). `test:edge` sms-inbound/sms-worker failures are a local Edge-runtime secret gap (CI provisions them); the 165 `audit_emit`-exercising contract tests pass. | Dev agent (claude-opus-4-7[1m]) |
