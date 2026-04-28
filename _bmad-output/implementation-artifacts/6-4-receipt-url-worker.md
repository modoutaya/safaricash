# Story 6.4: Receipt URL Cloudflare Worker with no-JS baseline

Status: ready-for-dev

## Story

As a **saver**,
I want **to open the URL in my SMS on any browser, including older feature phones' browsers, and see my transaction details rendered without JavaScript**,
so that **I can always verify my receipt regardless of device (FR30, UX-DR19).**

> **Predicate of this story.** Story 6.3 shipped `transactions.receipt_token` (32 hex chars / 128-bit entropy, unique idx, CHECK regex). The SMS templates already render the URL `https://safaricash.app/r/<token>` — Story 6.4 closes the loop by serving that surface via a Cloudflare Worker. Architecture (`architecture.md:835-841`) reserves the source-tree slot at `workers/receipt-url/{wrangler.toml, src/index.ts, src/render.ts, src/dispute.ts}` and the `workers/receipt-url/` directory was scaffolded with empty `src/` in Story 1.x. Story 6.4 fills index.ts + render.ts + the wrangler config; the dispute.ts file lands as a deferred-501 stub (Story 10.2 owns the POST handler — saver dispute submission flow per UX-DR20). **What Story 6.4 does NOT ship**: the dispute POST handler (Story 10.2); a JavaScript-driven UI (UX-DR19 forbids — the page MUST work no-JS); native mobile rendering polish (the page targets WCAG Level A; Level AA is a future iteration); the OG / Twitter-card metadata for shareability (out of scope at MVP). The Worker runs side-by-side with the existing rate-limit Worker (port 8787); receipt-url uses port 8788 in dev.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 1014-1022; the rest are spec-derived constraints required for a flawless implementation.

1. **Wrangler config — `workers/receipt-url/wrangler.toml`.** Mirrors `workers/rate-limit/wrangler.toml` patterns:
   - `name = "safaricash-receipt-url"`
   - `main = "src/index.ts"`
   - `compatibility_date = "2026-04-01"` (matches the rate-limit worker; bumping needs a deliberate Cloudflare-changelog review).
   - `[vars]` block with `SUPABASE_PROJECT_URL = "https://example.supabase.co"` placeholder. The pre-deploy lint script (Task 7) MUST reject this placeholder.
   - `[observability]` block with `enabled = true, head_sampling_rate = 1.0`.
   - **No KV namespace** — the receipt-url Worker is stateless (one-shot DB lookup per request). No `[[kv_namespaces]]` block.
   - **Secret expectation (NOT in [vars]):** `SUPABASE_SERVICE_ROLE_KEY` set via `wrangler secret put`. The Worker will refuse to start (returns 500 on first request) if the secret is unset. Story 6.4 does NOT bake the secret into source — operator runs the secret-put step at deploy time.
   - Document the deploy commands in a comment header (mirrors rate-limit's header).

2. **Pre-deploy lint script — `workers/receipt-url/scripts/check-config.mjs`.** Mirrors `workers/rate-limit/scripts/check-config.mjs`:
   - Reads `wrangler.toml`.
   - Rejects: `SUPABASE_PROJECT_URL = "https://example.supabase.co"`.
   - Rejects: empty `name` / `main` / `compatibility_date`.
   - Exit non-zero on any rejection.
   - Wired into a NEW npm script `worker:receipt-url:deploy` (mirrors `worker:rate-limit:deploy`).

3. **Worker entry — `workers/receipt-url/src/index.ts`** routes:
   - `GET /health` → 200 plain text `"ok"` (CI readiness probe; mirrors rate-limit's pattern).
   - `GET /r/{token}` where `token` matches `^[0-9a-f]{32}$` → call `renderReceiptPage(token, env)` (see AC #5).
   - `GET /r/{token}` where token does NOT match the regex → 404 plain text `"Reçu introuvable."` (defends against scanning probes; the regex check fires BEFORE any DB call).
   - `GET /r/{token}/dispute` → 501 plain HTML page saying *"Cette fonctionnalité arrive bientôt."* (Story 10.2 will replace this with the dispute submission form per UX-DR20).
   - `POST /r/{token}/dispute` → 501 plain text `"Story 10.2 will land this endpoint."` (placeholder).
   - **Any other path / method** → 404 plain text.
   - **Method gate:** only `GET` allowed (and `POST` to the dispute path which 501s); other methods → 405 plain text.

4. **Auth — `SUPABASE_SERVICE_ROLE_KEY`.** The Worker calls Supabase via service-role to bypass RLS (the saver doesn't have a JWT — receipt URLs are public-by-design per FR30). The service-role key is read from env at request time (not at module init — wrangler dev needs lazy env access). If the secret is unset, return 500 with `"Service unavailable"` plain text (no detail leak).

5. **Receipt-payload helper RPC — migration `20260430000001_get_receipt_payload.sql`.** New SECURITY DEFINER function `get_receipt_payload(p_token text) RETURNS table(...)`:
   ```sql
   create or replace function public.get_receipt_payload(p_token text)
   returns table (
     amount         numeric(12, 0),
     kind           text,
     cycle_day      int,
     created_at     timestamptz,
     member_first_name text,
     projected_balance numeric(12, 0),
     daily_amount   numeric(12, 0)
   )
   language sql
   security definer
   set search_path = public, pg_temp
   as $$
     -- Filter out soft-undone transactions (Story 4.5 handshake).
     -- transactions_decrypted view already excludes undone_at IS NOT NULL.
     select
       t.amount,
       t.kind::text,
       t.cycle_day,
       t.created_at,
       substring(unaccent(public.vault_decrypt(m.name_encrypted)) from '^[^ ]+') as member_first_name,
       (m.daily_amount * 29) - coalesce(
         (select sum(t2.amount)
            from public.transactions_decrypted t2
           where t2.cycle_id = t.cycle_id
             and t2.kind = 'advance'),
         0
       ) as projected_balance,
       m.daily_amount
     from public.transactions_decrypted t
     join public.members m on m.id = t.member_id
     where t.receipt_token = p_token;
   $$;
   ```
   - Returns 0 rows if the token is unknown OR the underlying transaction is soft-undone.
   - GRANT EXECUTE TO service_role; REVOKE FROM public + authenticated.
   - The Worker calls this via PostgREST RPC `POST /rest/v1/rpc/get_receipt_payload` with `Authorization: Bearer <service-role-key>`.

6. **Render module — `workers/receipt-url/src/render.ts`** exports:
   ```ts
   export type ReceiptPayload = {
     amount: number;
     kind: 'contribution' | 'rattrapage' | 'advance' | string;
     cycle_day: number;
     created_at: string;       // ISO 8601
     member_first_name: string;
     projected_balance: number;
     daily_amount: number;
   };

   export function renderReceiptHtml(token: string, payload: ReceiptPayload): string;
   export function renderNotFoundHtml(): string;
   export function renderComingSoonDisputeHtml(token: string): string;
   ```
   - Pure functions. No DOM, no React, no JSX — plain template-literal HTML. No JavaScript in the output (UX-DR19).
   - Output uses semantic HTML5 elements: `<main>`, `<header>`, `<section>`, `<h1>`, `<dl>` (definition list for amount/day/projected/created), `<a>` for the dispute CTA.
   - Inline `<style>` block in `<head>` — small custom CSS (≤ 2 KB), NOT Tailwind (Tailwind requires a build step the Worker doesn't run). Conservative styles: system-ui font stack, max-width 480px, generous line-height, high-contrast colours (≥ 4.5:1 for normal text per NFR-A3).
   - Mobile-first responsive: viewport meta `<meta name="viewport" content="width=device-width, initial-scale=1">`. Fluid layout, no media-query breakpoints (UX-DR19 — *"responsive fluid (no breakpoints)"*).
   - **Tracker-not-mover disclosure** (NFR-S10): a small `<aside>` at the bottom, *"SafariCash est un journal d'épargne et non une banque. Cette page documente votre transaction; aucune somme n'est mouvementée par SafariCash."* (the page can use accented French — UX-DR19 doesn't impose ASCII; that constraint is SMS-only). Use `lang="fr"` on `<html>`.
   - **Dispute CTA:** below the transaction details, a single `<a>` styled as a button — `<a href="/r/{token}/dispute" class="dispute-cta">Cette transaction n'est pas moi</a>`. Destructive-tint BG `#FAECE7` per UX-DR11. The link goes to the same Worker's deferred-501 placeholder (Story 10.2 will replace).
   - **Reversibility note:** below the CTA, smaller text *"Appuyé par erreur ? Vous pourrez annuler dans les 24h."* (UX-spec line 675).

7. **Receipt page content** (per BDD line 1017 — *"the page includes: amount, date/time, cycle day, projected final balance, and the dispute CTA"*):
   - **Header:** brand mark *"SafariCash"* + the saver's first name (decoded via the helper).
   - **Definition list:**
     - *Montant reçu* — `{amount} FCFA` formatted with thousands grouping (space separator).
     - *Date et heure* — `{created_at}` formatted as `JJ/MM/AAAA HH:MM` in Africa/Dakar timezone (UTC+0; no DST). Use `Intl.DateTimeFormat('fr-FR', { ... })` (Cloudflare Workers support this).
     - *Jour du cycle* — `{cycle_day} / 30`.
     - *Type d'opération* — `Contribution` / `Rattrapage` / `Prêt express` (translation of `kind`).
     - *Solde projeté en fin de cycle* — `{projected_balance} FCFA` (unless `kind='advance'` — then label as *"Nouveau solde projeté"* to make the post-advance recalculation legible).
   - **Dispute CTA section** (separate `<section>`).
   - **Disclosure aside.**

8. **Date formatting timezone.** All saver-facing timestamps render in **Africa/Dakar** (UTC+0; no DST). Use `Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Dakar', ... })`. Dakar is UTC+0 year-round so the result is identical to UTC, but the timezone declaration future-proofs against any TZ change.

9. **Error rendering — `renderNotFoundHtml`.** When `get_receipt_payload` returns 0 rows, the Worker responds with HTTP 404 + a semantic HTML 404 page. The 404 page:
   - Same brand header.
   - A simple message: *"Reçu introuvable. Le lien que vous avez ouvert n'existe pas, ou la transaction a été annulée."*
   - A small disclosure aside (same tracker-not-mover phrase).
   - **No re-direct, no JavaScript.** Plain HTML.
   - **MUST NOT leak whether the token was malformed vs unknown vs undone** — same body for all 3.

10. **Caching headers.** Receipt pages contain saver-specific data:
    - `Cache-Control: private, no-store` — prevent intermediary caching (CDN, browser back-forward cache, etc.). Each load is a fresh DB hit.
    - `Pragma: no-cache` (HTTP/1.0 fallback).
    - 404 responses: same headers (consistent posture).
    - `Content-Type: text/html; charset=utf-8`.
    - `X-Content-Type-Options: nosniff`.
    - `X-Frame-Options: DENY` (defends against clickjacking the dispute CTA).
    - `Referrer-Policy: same-origin`.

11. **Token regex defence.** The path-param regex `^[0-9a-f]{32}$` runs in the Worker BEFORE any Supabase round trip. A scanning probe with a malformed path gets 404 directly from Cloudflare's edge, not a DB hit. Audit this in a unit test.

12. **No PII in logs.** The Worker MAY log `{level, event, token_prefix: token.slice(0, 4), result}` — the 4-char prefix is enough for forensic correlation without exposing the full token. NEVER log the full token, member name, or amount.

13. **Operator setup.** The Worker is deployed to a Cloudflare Workers route configured to serve `safaricash.app/r/*`. Operator runs:
    ```
    cd workers/receipt-url
    wrangler secret put SUPABASE_SERVICE_ROLE_KEY  # paste the prod key
    npm run worker:receipt-url:deploy
    # Then in Cloudflare dashboard: Routes → add safaricash.app/r/* → safaricash-receipt-url
    ```
    Document this in a `workers/receipt-url/README.md` (NEW; mirror `workers/rate-limit/README.md`'s structure).

14. **No new npm dependencies.** The Worker uses Web standard APIs only:
    - `fetch` (Cloudflare-built-in)
    - `Request` / `Response`
    - `URL`, `URLPattern`
    - `Intl.DateTimeFormat`
    - No npm packages → minimal cold start.
    - **Do NOT add the supabase-js client** to the Worker. Make raw POST calls to `${SUPABASE_PROJECT_URL}/rest/v1/rpc/get_receipt_payload` with `Authorization: Bearer <service-role-key>` + `apikey: <service-role-key>` headers + JSON body `{"p_token": "<token>"}`. Total bundle: ~5 KB after esbuild.

15. **Tests — render unit tests (vitest).** New `workers/receipt-url/src/render.test.ts`:
    - `renderReceiptHtml('a'.repeat(32), { amount: 500, kind: 'contribution', cycle_day: 1, created_at: '2026-04-28T10:00:00Z', member_first_name: 'Fatou', projected_balance: 14_500, daily_amount: 500 })` → returns a string that:
      - Contains `<html lang="fr">`.
      - Contains `Fatou` in the header.
      - Contains `500 FCFA` (amount).
      - Contains `14 500 FCFA` (projected with space grouping).
      - Contains `1 / 30` (cycle day).
      - Contains the disclosure phrase.
      - Contains the dispute CTA `<a href="/r/...dispute"`.
      - Does NOT contain `<script>` (no-JS rule).
      - Has `<meta name="viewport"` for mobile.
    - `renderReceiptHtml(... { kind: 'advance', ... })` → contains `Prêt express` label + uses *"Nouveau solde projeté"* heading.
    - `renderNotFoundHtml()` → contains `Reçu introuvable.` + same disclosure aside.
    - `renderComingSoonDisputeHtml(token)` → contains *"Cette fonctionnalité arrive bientôt."* + a back-link to `/r/{token}`.
    - **A11y sanity** (vitest + jest-axe) — feed each rendered HTML to axe via JSDOM; assert no Level-A violations. UX-DR19 commits to Level A.
    - **Token regex unit** — a `tokenIsValid(token: string): boolean` helper exported from `index.ts` (or a sibling `src/token.ts`) is unit-tested with: 32-hex valid, 31-char invalid, 33-char invalid, 32 chars with `g` invalid, empty invalid.

16. **Tests — Worker integration via wrangler dev (Playwright + curl).** New `tests/e2e/receipt-url-worker.spec.ts`:
    - Starts wrangler dev separately (CI step launches it with `--port 8788`); the Playwright spec connects to `http://127.0.0.1:8788`.
    - **Case 1** — `GET /health` → 200 `"ok"`.
    - **Case 2** — `GET /r/<seeded-valid-token>` → 200 + HTML body containing the seeded amount + the saver's first name.
    - **Case 3** — `GET /r/<malformed-token>` (e.g., `xyz`) → 404 + `"Reçu introuvable."` text.
    - **Case 4** — `GET /r/<unknown-32-hex>` (valid format, no DB row) → 404 + same body.
    - **Case 5** — `GET /r/<undone-tx-token>` (seeded contribution, then `undo_transaction` RPC fired within 5 s) → 404 + same body (Story 4.5 handshake — undone rows are invisible to the receipt page).
    - **Case 6** — `GET /r/<valid-token>/dispute` → 501 + *"Cette fonctionnalité arrive bientôt."*
    - **Case 7** — `POST /r/<valid-token>/dispute` → 501 + plain text.
    - **Case 8** — `GET /unknown-path` → 404.
    - **Case 9** — `PUT /r/<valid-token>` → 405.
    - **Test seed setup**: the spec seeds a collector + member + contribution via the Supabase service-role REST API, captures the auto-generated `receipt_token`, then runs the assertions. Tear-down deletes the seed.

17. **Tests — vitest worker module tests run as part of the main vitest suite.** Add `workers/receipt-url/**/*.test.ts` to the existing `vitest.config.ts` include glob (or rely on the existing Workers-source globbing — verify by listing `workers/rate-limit/src/*.test.ts` against the current vitest run).

18. **CI integration.** Update `.github/workflows/ci.yml`:
    - Add a SECOND wrangler-dev start step for the receipt-url Worker on port 8788 (after the rate-limit worker step at line 84).
    - Add a corresponding kill step at the end (mirror line 196 `Stop wrangler dev`).
    - The Playwright job (line 52) already runs all `tests/e2e/*.spec.ts` — the new receipt-url spec is picked up automatically.

19. **Deploy — npm scripts.** Add to `package.json`:
    - `"worker:receipt-url:deploy": "node workers/receipt-url/scripts/check-config.mjs && wrangler deploy --config workers/receipt-url/wrangler.toml"`
    - `"worker:receipt-url:dev": "wrangler dev --config workers/receipt-url/wrangler.toml --port 8788 --ip 127.0.0.1"`
    - Update root `README.md` (or `workers/receipt-url/README.md` — mirror rate-limit's structure) with deploy steps.

20. **No Supabase migration changes beyond AC #5.** The receipt-url Worker reads from Story 6.3's `transactions.receipt_token` column via the new helper RPC. No schema mutations.

21. **All gates green.**
    - `npm run typecheck` (vitest pulls Worker src too via the existing tsconfig; ensure `workers/receipt-url/tsconfig.json` extends the root with `"types": ["@cloudflare/workers-types"]`). Add `@cloudflare/workers-types` if it's not already a devDep — verify in `package.json`.
    - `npm run lint` — ESLint is configured for `workers/**/*.ts` per the existing setup.
    - `npm run test` (vitest sanity + new render unit tests).
    - `npm run test:edge` (Deno; unchanged — no Supabase Edge Function changes).
    - `npm run build` — Worker is NOT bundled into the main Vite build; ensure no client-side import accidentally pulls Worker code.
    - `npx playwright test tests/e2e/receipt-url-worker.spec.ts` — the new Playwright spec.

## Tasks / Subtasks

- [ ] **Task 1 — Wrangler config + check-config script** (AC: #1, #2)
  - [ ] `workers/receipt-url/wrangler.toml` with placeholder `SUPABASE_PROJECT_URL`.
  - [ ] `workers/receipt-url/scripts/check-config.mjs` mirrors `workers/rate-limit/scripts/check-config.mjs` (rejects placeholders).
  - [ ] Add `worker:receipt-url:deploy` + `worker:receipt-url:dev` to `package.json`.
  - [ ] `workers/receipt-url/README.md` documents the deploy + secret-put steps.
  - [ ] `workers/receipt-url/tsconfig.json` extends root with `@cloudflare/workers-types`.

- [ ] **Task 2 — Migration 0043: `get_receipt_payload` RPC** (AC: #5)
  - [ ] Save as `supabase/migrations/20260430000001_get_receipt_payload.sql`.
  - [ ] SECURITY DEFINER, returns table per AC #5.
  - [ ] Apply via `npm run db:migrate`; regenerate types via `npm run db:types --local`.

- [ ] **Task 3 — Render module** (AC: #6, #7, #8, #9)
  - [ ] `workers/receipt-url/src/render.ts` exports `renderReceiptHtml`, `renderNotFoundHtml`, `renderComingSoonDisputeHtml`.
  - [ ] Inline `<style>` block; no Tailwind, no JS.
  - [ ] `Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Dakar', ... })`.
  - [ ] French copy verbatim per AC #6 / #7 / #9.
  - [ ] Brand header / disclosure aside / dispute CTA / reversibility note.

- [ ] **Task 4 — Worker entry index.ts** (AC: #3, #4, #10, #11, #12, #14)
  - [ ] `workers/receipt-url/src/index.ts` exports `default { fetch(req, env) { ... } }`.
  - [ ] Route table: `/health`, `/r/{token}`, `/r/{token}/dispute`, fallthrough 404.
  - [ ] Token regex `^[0-9a-f]{32}$` BEFORE Supabase lookup.
  - [ ] Service-role POST to `${SUPABASE_PROJECT_URL}/rest/v1/rpc/get_receipt_payload`.
  - [ ] Caching + security headers per AC #10.
  - [ ] Structured logging — token prefix only, never full token / PII.
  - [ ] No npm deps.

- [ ] **Task 5 — Token validation helper + unit tests** (AC: #11, #15)
  - [ ] `workers/receipt-url/src/token.ts` exports `tokenIsValid(token: string): boolean`.
  - [ ] `workers/receipt-url/src/token.test.ts` — 5 cases.

- [ ] **Task 6 — Render unit tests** (AC: #15)
  - [ ] `workers/receipt-url/src/render.test.ts` — 3 happy-path cases (contribution, advance, rattrapage) + 404 + coming-soon + jest-axe Level A check.

- [ ] **Task 7 — Worker integration tests** (AC: #16)
  - [ ] `tests/e2e/receipt-url-worker.spec.ts` — 9 cases per AC #16.
  - [ ] Seeds collector + member + transaction via service-role REST. Captures `receipt_token` from the response. Tears down.

- [ ] **Task 8 — CI workflow update** (AC: #18)
  - [ ] Add wrangler-dev start step for receipt-url on port 8788 in `.github/workflows/ci.yml`.
  - [ ] Add corresponding kill step.

- [ ] **Task 9 — Verify all gates green** (AC: #21)
  - [ ] `npm run typecheck` / `lint` / `test` / `test:edge` / `build` all green.
  - [ ] Local: `npm run worker:receipt-url:dev` + `curl http://127.0.0.1:8788/health` returns `ok`.
  - [ ] Local: `curl http://127.0.0.1:8788/r/<token>` against a seeded transaction returns the rendered HTML.

## Dev Notes

### Architecture intelligence

- **architecture.md:97** — *"Cloudflare serves PWA assets + receipt URL page (edge compute via Workers for the public surface)."*
- **architecture.md:835-841** — source-tree slot reserved for `workers/receipt-url/{wrangler.toml, src/index.ts, src/render.ts, src/dispute.ts}`. Story 6.4 fills index.ts + render.ts; dispute.ts is a 501-stub that Story 10.2 owns.
- **architecture.md:1115** — *"Flow 4 — Dispute | `workers/receipt-url/src/` (public surface), `src/features/dispute/` (collector-side)"*. The Worker is the saver-facing surface; the collector-side notification flow is Epic 10.
- **prd.md:516 (FR30)** — *"A saver can access a public, tokenized receipt page via the receipt URL on any browser, without authentication. The receipt page exposes no information beyond what was contained in the SMS."*
- **prd.md:596 (NFR-A1)** — *"Receipt URL page (saver-facing) targets Level A minimum"*. Verified by jest-axe assertions (Task 6).
- **prd.md:582 (NFR-S10)** — banking-language audit also applies to the receipt page; the disclosure aside ships the tracker-not-mover phrase.

### Story 6.3 handshake — receipt_token + URL prefix

- Story 6.3 ships `transactions.receipt_token` (32 hex chars). Story 6.4 reads it via the new RPC.
- Story 6.3's SMS templates hard-code `https://safaricash.app/r/<token>`. **Operator setup**: Cloudflare route `safaricash.app/r/*` → `safaricash-receipt-url` Worker. The route prefix `/r/` must match.
- The `app.receipt_url_base` GUC introduced in Story 6.3 lets per-environment overrides (dev/staging) point at different Worker URLs (e.g., `http://127.0.0.1:8788/r` for local dev). Document the override step in the README.

### Story 4.5 handshake — soft-undo invisibility

- The helper RPC reads from `public.transactions_decrypted` (NOT the raw `transactions` table). The view filters out `undone_at IS NOT NULL` rows since Story 4.5 (`migration 20260426000006_transactions_decrypted_excludes_undone.sql`). So a saver who taps a URL within the 5-s undo window — and the collector then undoes — gets a 404 once the cache TTL expires (instant, since `Cache-Control: private, no-store`).

### Story 10.2 handshake — dispute submission

- Story 10.2 wires the actual POST `/r/{token}/dispute` form handler. Story 6.4 ships the GET-side scaffold (the dispute CTA + the deferred-501 GET/POST routes). Story 10.2 will:
  - Replace the 501 GET stub with the actual dispute form (UX-DR20 — bottom-sheet confirmation, optional free-text, compassionate acknowledgment screen).
  - Replace the 501 POST stub with handler that inserts a `disputes` row + dispatches the `dispute_ack` SMS via `format_sms_body('dispute_ack', tx_id)` (Story 6.3's helper).
  - Notify the collector + founder per FR33b (`supabase/functions/dispute-notify/`).

### No-JS discipline (UX-DR19)

- Every interactive element is an `<a>` or `<form>` — both work without JavaScript. Story 6.4 has ZERO interactive elements (the dispute CTA is just a link to a 501 page); Story 10.2 will introduce the actual form (still no-JS — server-rendered confirmation flow).
- The render module emits a single self-contained HTML document per request. No external scripts, no analytics, no fonts (system-ui only).

### Token entropy (NFR-S3)

- Story 6.3 generates the token via `encode(gen_random_bytes(16), 'hex')` — 16 bytes = 128 bits of entropy, well above the NFR-S3 floor.
- The Worker's regex check `^[0-9a-f]{32}$` filters obviously-malformed tokens but does NOT validate that the token was generated by the system. The actual existence check is the Supabase RPC lookup.
- Document the lookup-vs-existence distinction in a code comment so future devs don't add a "verify token signature" step that wouldn't help (an opaque 128-bit token IS its own existence proof — guess-rate is `1 / 2^128`).

### Performance + correctness caveats

- The Worker does ONE Supabase REST round trip per receipt page (the helper RPC). Cold-start budget on Cloudflare Workers: < 5 ms (Workers are pre-warmed). Network: ~50-100 ms to Supabase. Total p95 < 200 ms.
- No connection pooling — Cloudflare Workers reuse fetch connections within a single worker isolate, but each request opens a fresh connection to Supabase. Acceptable for MVP.
- Bundle size budget: < 10 KB gzipped after esbuild. Verified post-build via `wrangler deploy --dry-run --outdir=dist` — fail CI if > 20 KB.

### Project structure notes

- Source tree:
  - NEW: `workers/receipt-url/wrangler.toml`
  - NEW: `workers/receipt-url/tsconfig.json`
  - NEW: `workers/receipt-url/README.md`
  - NEW: `workers/receipt-url/scripts/check-config.mjs`
  - NEW: `workers/receipt-url/src/index.ts`
  - NEW: `workers/receipt-url/src/render.ts`
  - NEW: `workers/receipt-url/src/render.test.ts`
  - NEW: `workers/receipt-url/src/token.ts`
  - NEW: `workers/receipt-url/src/token.test.ts`
  - NEW: `workers/receipt-url/src/dispute.ts` (501 placeholder stub)
  - NEW: `supabase/migrations/20260430000001_get_receipt_payload.sql`
  - NEW: `tests/e2e/receipt-url-worker.spec.ts`
  - MODIFIED: `package.json` (2 new npm scripts)
  - MODIFIED: `.github/workflows/ci.yml` (wrangler-dev start + stop for receipt-url on port 8788)
  - MODIFIED: `src/infrastructure/supabase/database.types.ts` (re-generated; new RPC types)
  - MODIFIED: `_bmad-output/implementation-artifacts/sprint-status.yaml`
- All paths align with architecture.md § Source Tree.
- No conflicts with prior stories.

### Testing standards

- Render module: pure-function unit tests (vitest + jest-axe).
- Token regex: pure-function unit tests.
- Worker integration: Playwright spec via wrangler dev (mirrors the existing rate-limit pattern).
- The receipt-url Worker has NO Deno tests (it's not a Supabase Edge Function); test:edge runs unchanged.

### References

- [Source: epics.md#Story 6.4] — BDD acceptance criteria.
- [Source: epics.md#UX-DR19] — semantic HTML / no-JS / WCAG Level A baseline.
- [Source: epics.md#UX-DR20] — dispute submission flow (Story 10.2 territory; CTA stub here).
- [Source: ux-design-specification.md:670-678] — saver dispute flag surface design direction.
- [Source: prd.md#FR30] — public tokenized receipt page.
- [Source: prd.md#FR33b] — saver dispute flag (Story 10.2 owns).
- [Source: prd.md#NFR-A1 / NFR-A3] — Level A accessibility floor + 4.5:1 contrast.
- [Source: prd.md#NFR-S3] — receipt token ≥ 128 bits (Story 6.3 enforces at insertion).
- [Source: prd.md#NFR-S10] — banking-language audit + tracker-not-mover disclosure.
- [Source: workers/rate-limit/wrangler.toml] — sibling Worker config pattern.
- [Source: workers/rate-limit/scripts/check-config.mjs] — pre-deploy lint pattern.
- [Source: .github/workflows/ci.yml:84-108] — wrangler dev start step pattern.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

### Completion Notes List

Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
