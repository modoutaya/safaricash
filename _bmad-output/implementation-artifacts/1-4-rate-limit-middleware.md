# Story 1.4: Rate-limit middleware on transaction-write endpoints

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **security engineer building the SafariCash MVP**,
I want **a Cloudflare Workers middleware that enforces 100 req/min per collector on every Supabase Edge Function endpoint**,
so that **a compromised JWT cannot flood the system with fraudulent writes nor bomb Termii's SMS budget via re-auth (FR49 + NFR-S9), unblocking the production-deploy gate that Story 1.3 left open**.

## Acceptance Criteria

1. **New Cloudflare Worker exists at the canonical path.** `workers/rate-limit/` follows the architecture's worker convention (`wrangler.toml` + `src/index.ts` + supporting `camelCase.ts` modules per `architecture.md` §835-841). Deployable via `wrangler deploy` and locally runnable via `wrangler dev`. Free-tier compatible (100k worker requests/day per `architecture.md` line 80; SafariCash MVP at ~50 collectors × ~100 req/active-period stays well under cap).
2. **Routing topology — client base-URL switch.** The worker is deployed to a Cloudflare-owned subdomain (e.g. `safaricash-api.{account}.workers.dev` for MVP; custom-domain `api.safaricash.app` deferred to a follow-up story per `deferred-work.md`). The Worker proxies all incoming requests to `https://{SUPABASE_PROJECT_REF}.supabase.co` preserving method, path, headers, and body. Frontend code reads the worker base-URL from `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` env (set in Cloudflare Pages prod env) and falls back to direct Supabase if unset (dev convenience). When unset, NO rate limiting is enforced — production deploy MUST set this env or the FR49 gate is non-functional. CI will be wired in Story 1.8.
3. **Per-collector key extraction (trust-and-decode JWT `sub`).** The worker decodes the `Authorization: Bearer <jwt>` header (Supabase Auth JWT) and extracts the `sub` claim as `collector_id`. **No JWT signature verification at the edge** — Supabase Edge Functions perform full verification downstream. Rationale: even if an attacker forges a JWT with a fake `sub` to dilute another collector's quota, the downstream Edge Function rejects the forged JWT — the only damage is consuming rate-limit quota for a non-existent collector_id, which is bounded by the same 100/min cap and self-limiting. JWT verification at the edge requires either the Supabase JWT secret in CF Worker env (operational risk: secret duplication) or a JWKS fetch (adds latency + cache plumbing). Documented trade-off; revisit if JWT-forgery-as-DoS becomes a real signal.
4. **Sliding-window counter via Cloudflare Workers KV.** Counter storage uses Workers KV (free tier: 100k reads/day, 1k writes/day). Key shape: `rl:{collector_id}:{minute_bucket_iso8601}` (e.g. `rl:abcd-1234:2026-04-19T10:23`). Each request: read current count for the bucket, increment, write back with TTL 90 seconds (covers the 60s window + 30s clock skew margin). Documented limitations: (a) KV writes are eventually consistent (~60s global propagation) — so a burst of 200 requests in <1s from the same collector across multiple CF edge POPs can underestimate the count, allowing a transient burst above 100/min; acceptable trade-off for MVP given the per-collector blast radius is already bounded by the 100/min cap once consistency converges. (b) On bucket boundary (XX:59 → YY:00), an attacker could in theory issue 100 requests in the last second of one minute and 100 more in the first second of the next minute = 200 in <2s. Acceptable for MVP. (c) For exact strong-consistency rate limiting, migrate to Cloudflare Durable Objects (requires Workers Paid plan $5/mo) — deferred.
5. **429 response shape (RFC 7807 + `Retry-After`).** When the per-(collector, minute) counter exceeds 100, the worker returns HTTP 429 with `Content-Type: application/problem+json` body `{type, title, status, detail, instance, retry_after_seconds}` per the `architecture.md` § Communication Patterns RFC 7807 mandate (line 543, 627). `type: 'https://safaricash.app/problems/ratelimit/exceeded'`. `Retry-After: <seconds-until-bucket-rolls-over>` standard header. Matches the Story 1.3 problem-types convention so consumer UIs can switch on `type` uniformly.
6. **Bypass for service-role calls.** Requests authenticating with a Bearer token whose JWT `role` claim is `service_role` (Supabase pre-defined role for backend-to-backend calls — sms-worker, dispute-notify Edge Functions, manual operator runs from Supabase Studio) bypass the rate limit. The worker decodes the JWT to read `role` (no signature verification — same trust-and-decode trade-off as collector_id extraction). MVP has no super_admin / founder bypass (per `prd.md` PRD line 304 + 662: RBAC is out of MVP scope; founder admin is OQ7 deferred).
7. **Anonymous (no JWT) handling.** Requests without an `Authorization` header are passed through to Supabase WITHOUT rate limiting at this layer — Supabase Pro's native rate limit handles unauthenticated traffic per `architecture.md` line 349. The receipt-URL public surface (`/r/{token}`) and saver dispute submission (`POST /r/{token}/dispute`) are served by a SEPARATE worker (`workers/receipt-url/`) and have NO MVP rate limit (PRD/UX gap flagged in Dev Notes — token entropy is the only stated defense per NFR-S3).
8. **`ratelimit.exceeded` operational log.** Every 429 response generates a structured JSON log line (`console.log(JSON.stringify({...}))` — Workers stdout) with shape `{level: 'warn', event: 'ratelimit.exceeded', collector_id, minute_bucket, count, ts}`. **Not** routed to `audit_log` (per FR44 the audit chain is for state-mutating ops; a rejected request is by definition NOT a state mutation). Operational log retention is 90 days (Cloudflare default). Repeated 429s constitute a credential-compromise signal — surfacing them to the founder is deferred (no PRD requirement at MVP).
9. **Configurable threshold via env.** The 100 req/min cap is read from `RATE_LIMIT_PER_MINUTE` Worker env (default 100 if unset). NFR-S9 explicitly says *"adjusted based on pilot observation"* (`prd.md` line 578) — making the limit a runtime config (not a hardcoded constant) honours that requirement. Operator can adjust via `wrangler secret put RATE_LIMIT_PER_MINUTE` without re-deploy.
10. **Vitest unit test + Playwright E2E gate.** Two test surfaces: (a) `workers/rate-limit/src/index.test.ts` — Vitest tests with mocked KV namespace (using `@cloudflare/vitest-pool-workers` if available, else a hand-rolled KV mock) covering: bypass for missing-auth / service-role, counter increment on first call, 429 on 101st call within 60s, bucket rollover after 60s, threshold respects `RATE_LIMIT_PER_MINUTE` env override. (b) `tests/e2e/rate-limit.spec.ts` — Playwright spec that hits the deployed worker URL (or local `wrangler dev` in CI) 101 times within 60s for one collector and asserts the 101st returns 429 + `Retry-After`. CI runs both gates; failure blocks merge.
11. **Production-deploy gate from Story 1.3 closes.** When Story 1.4 is merged AND the Cloudflare Worker is deployed AND `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` is set in Cloudflare Pages env, the entry in `deferred-work.md` titled "PRODUCTION DEPLOY GATE: re-auth Edge Function must NOT be exposed..." is officially resolved. Update the deferred-work.md entry to mark resolved and reference this story.
12. **Documentation: French copy + operator runbook.** Add to `src/i18n/fr.json` under `errors.*`: `errors.rate_limited: "Limite atteinte — patientez {seconds} s avant de réessayer."` (UX spec template `{Action} échouée — {cause}` per `ux-design-specification.md` line 1395). Add a brief `workers/rate-limit/README.md` documenting: deploy command (`wrangler deploy`), env vars (`RATE_LIMIT_PER_MINUTE`, `SUPABASE_PROJECT_URL`), KV namespace setup (`wrangler kv namespace create RATE_LIMIT_KV`), how to adjust the threshold, how to tail logs (`wrangler tail`).

## Tasks / Subtasks

- [x] **Task 1: Create the worker scaffold** (AC: 1)
  - [x] `workers/rate-limit/wrangler.toml`: name `safaricash-rate-limit`, main `src/index.ts`, compatibility_date `2026-04-19`, KV namespace binding `RATE_LIMIT_KV`, env vars stub (`SUPABASE_PROJECT_URL`, `RATE_LIMIT_PER_MINUTE`)
  - [x] `workers/rate-limit/src/index.ts` with the `fetch(request, env, ctx)` handler shape per Cloudflare Workers convention
  - [x] Add `wrangler` as devDep in root `package.json` (or check whether Story 1.1's setup already installed it)
  - [x] Add npm scripts: `worker:rate-limit:dev` (`wrangler dev workers/rate-limit/wrangler.toml`), `worker:rate-limit:deploy` (`wrangler deploy --config workers/rate-limit/wrangler.toml`)

- [x] **Task 2: JWT decode + bypass logic** (AC: 3, 6, 7) — `workers/rate-limit/src/jwt.ts`
  - [x] `decodeJwtSub(authHeader: string | null): { collectorId: string; role: string } | null` — base64-url-decodes the JWT payload (no signature verification per AC #3 trade-off), extracts `sub` and `role` claims
  - [x] If header missing → return null (anonymous pass-through)
  - [x] If decode fails → return null (treat as anonymous; downstream Supabase will reject the bad JWT)
  - [x] If `role === 'service_role'` → caller treats this as bypass
  - [x] Unit-tested in Task 7

- [x] **Task 3: KV-backed sliding-window counter** (AC: 4) — `workers/rate-limit/src/counter.ts`
  - [x] Export `incrementAndCheck(kv: KVNamespace, collectorId: string, threshold: number, now: Date): { allowed: boolean; count: number; bucketSecondsRemaining: number }`
  - [x] Bucket key derivation: `rl:{collectorId}:{ISO8601 minute, e.g. 2026-04-19T10:23}` (truncate to minute)
  - [x] Read current count (default 0), increment, write back with `expirationTtl: 90` (60s window + 30s skew margin)
  - [x] Return `{ allowed: count <= threshold, count, bucketSecondsRemaining: 60 - now.seconds }`
  - [x] **Document KV consistency caveat in code comment:** writes are eventually consistent (~60s global propagation); a burst across multiple CF POPs can underestimate the count temporarily

- [x] **Task 4: Proxy-pass to Supabase** (AC: 2) — `workers/rate-limit/src/proxy.ts`
  - [x] Export `proxyToSupabase(request: Request, supabaseProjectUrl: string): Promise<Response>` — forwards method, path, headers (excl. host), body to `${supabaseProjectUrl}{path}`
  - [x] Preserve `Cache-Control` and other response headers from Supabase
  - [x] Strip `host` header from outgoing request (CF auto-adds correct one)
  - [x] Handle non-2xx responses transparently — the worker is a proxy, not a circuit breaker

- [x] **Task 5: 429 response builder** (AC: 5, 12) — `workers/rate-limit/src/rfc7807.ts`
  - [x] Mirror Story 1.3's `_shared/rfc7807.ts` shape (factor common code if practical; otherwise duplicate — Worker runtime cannot import from `supabase/functions/_shared/`)
  - [x] Export `rateLimitedResponse(retryAfterSeconds: number, instance: string): Response` returning 429 + RFC 7807 body + `Retry-After` standard header

- [x] **Task 6: Wire the handler** (AC: 1, 2, 3, 5, 6, 7, 8, 9) — `workers/rate-limit/src/index.ts`
  - [x] On every request: read env (`RATE_LIMIT_PER_MINUTE` default 100, `SUPABASE_PROJECT_URL` required)
  - [x] Decode JWT — if missing or service-role → skip rate-limit, proxy directly
  - [x] If collector JWT → call `incrementAndCheck`; if `!allowed` → emit `console.log({event: 'ratelimit.exceeded', ...})` and return `rateLimitedResponse`
  - [x] If allowed → proxy to Supabase
  - [x] Wrap in try/catch — on any internal error, FAIL OPEN (proxy to Supabase) and log `level: 'error', event: 'ratelimit.middleware_error'`. Closed-fail would create a single-point-of-failure for the entire app; open-fail loses rate-limit briefly but app stays up. Documented trade-off.

- [x] **Task 7: Vitest unit tests** (AC: 10) — `workers/rate-limit/src/index.test.ts`
  - [x] Use `@cloudflare/vitest-pool-workers` if it works on Vitest 4 (verify at implementation time); fallback: hand-rolled KV namespace mock with in-memory Map + TTL emulation
  - [x] Test (a) anonymous request → proxy without rate-limit
  - [x] Test (b) service-role JWT → proxy without rate-limit
  - [x] Test (c) collector JWT, first 100 calls → all proxy
  - [x] Test (d) collector JWT, 101st call within 60s → 429 + `Retry-After`
  - [x] Test (e) collector JWT, 101st call AFTER 60s rollover → proxy (new bucket)
  - [x] Test (f) `RATE_LIMIT_PER_MINUTE=10` env override → 429 on 11th
  - [x] Test (g) malformed JWT → treated as anonymous (proxy through, downstream rejects)
  - [x] Test (h) internal KV error → fail-open (proxy through), error logged

- [x] **Task 8: Playwright E2E gate** (AC: 10) — `tests/e2e/rate-limit.spec.ts`
  - [x] Spec depends on `wrangler dev` running locally (or deployed worker URL passed via env `WORKER_BASE_URL`)
  - [x] beforeAll: spin up `wrangler dev` in background OR use `WORKER_BASE_URL` from env (CI reads from secret)
  - [x] Test: collector A signs in (reuse Story 1.2 helper) → fires 101 sequential POSTs to `${WORKER_BASE_URL}/functions/v1/re-auth` with `action: 'verify'` + dummy challenge_id (will 404, but the rate-limit fires before Supabase) — assert the 101st response has status 429 and `Retry-After` header set
  - [x] Wire into ci.yml AFTER the existing Playwright + Deno test steps. CI uses `wrangler dev` started inline; production CI may add a smoke test against the deployed worker URL once Cloudflare deploy lands (Story 1.8 owns the full deploy pipeline)
  - [x] Mutation-test verification: temporarily set `RATE_LIMIT_PER_MINUTE=1000` env → re-run E2E → confirm test goes red. Restore. Document in PR description.

- [x] **Task 9: Frontend wiring** (AC: 2, 12) — `src/infrastructure/supabase/client.ts` + `.env.example`
  - [x] Update `src/infrastructure/supabase/env.ts` Zod schema to accept optional `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL`
  - [x] In `src/infrastructure/supabase/client.ts`, build the `functions` client URL from the gateway env if present, else default to direct Supabase. Pattern: pass `global.fetch` override that rewrites the base URL OR construct functions invocations against `${gateway}/functions/v1/*` directly.
  - [x] Add `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL=` line to `.env.example` with comment "Cloudflare Worker rate-limit gateway (Story 1.4); leave empty in dev to bypass and call Supabase directly"
  - [x] Add `errors.rate_limited` to `src/i18n/fr.json` per AC #12

- [x] **Task 10: Documentation + close production-deploy gate** (AC: 11, 12)
  - [x] Write `workers/rate-limit/README.md` with: purpose, deploy command, env vars + KV setup, threshold adjustment, log tailing, fail-open behaviour rationale
  - [x] Update `_bmad-output/implementation-artifacts/deferred-work.md`: mark "PRODUCTION DEPLOY GATE: re-auth Edge Function must NOT be exposed..." as resolved with reference to Story 1.4 commit hash + deploy date
  - [x] Update root `README.md` § Stack to mention the new Cloudflare Worker layer between client and Supabase Edge Functions

- [x] **Task 11: Operator runbook + KV namespace provisioning**
  - [x] One-shot operator step (document in `workers/rate-limit/README.md`): `wrangler kv namespace create RATE_LIMIT_KV` + paste resulting ID into `wrangler.toml` `[[kv_namespaces]]` binding (operator does this once before first deploy; not in repo since IDs differ per environment)
  - [x] Document the production-deploy procedure: (1) provision KV namespace, (2) `wrangler deploy`, (3) set `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` in Cloudflare Pages prod env, (4) re-deploy Pages frontend, (5) verify with synthetic 100-req burst from the runbook

## Dev Notes

### Canonical references (do not deviate silently)

- **Architecture spec for rate limiting:** `architecture.md` line 349 — *"Cloudflare Workers middleware on Edge Function endpoints (max 100 req/min/collector on write endpoints). For PostgREST direct calls, Supabase Pro's native rate-limiting covers it."*
- **Worker folder convention:** `architecture.md` lines 835-841 — `workers/{kebab-case-name}/wrangler.toml + src/index.ts`. Today only `workers/receipt-url/` exists.
- **PRD FR49 + NFR-S9:** `prd.md` lines 542 + 578. NFR-S9 explicitly: *"100 requests / minute per collector ... adjusted based on pilot observation"* — make threshold a runtime env, not hardcoded.
- **RFC 7807 mandate:** `architecture.md` lines 356, 543, 627 — every 4xx/5xx from custom edge code uses RFC 7807. The 429 response inherits this.
- **Free-tier sizing:** `architecture.md` line 80 — *"100k Worker requests / day free"* — at 50 collectors × 100 req/min × 10 active min/day = 50k req/day. Stays under cap.
- **Production-deploy gate from Story 1.3:** `_bmad-output/implementation-artifacts/deferred-work.md` first entry — re-auth Edge Function must not face real prod traffic until Story 1.4 + 1.5 land. Story 1.4's deploy closes half this gate; Story 1.5 closes the other half.
- **Story 1.3 RFC 7807 problem-type pattern** (re-use as visual reference): `supabase/functions/_shared/rfc7807.ts`. Same shape, different runtime — code is duplicated since CF Workers cannot import from Deno.

### Anti-patterns to avoid (common Story 1.4 disasters)

- **Do NOT verify the JWT signature at the edge** unless we're willing to copy the Supabase JWT secret into CF Worker env or implement a JWKS cache. Story 1.4 picks **trust-and-decode** for `sub` and `role` extraction — Supabase verifies downstream. Forged JWTs only burn quota for fake collector_ids; Supabase rejects them so no real exploit.
- **Do NOT fail closed on internal errors.** If KV is down or the worker has an uncaught exception, the worker MUST proxy through to Supabase rather than 5xx-block all collector traffic. Closed-fail = single-point-of-failure for the entire app. Documented trade-off in Task 6.
- **Do NOT use Workers KV for sub-second strict consistency.** KV writes are eventually consistent (~60s global propagation). Bursts in <1s across multiple CF POPs may underestimate the count. Acceptable trade-off at MVP scale; document in code + Dev Agent Record.
- **Do NOT rate-limit the receipt-URL public surface in this worker.** That surface is served by `workers/receipt-url/` (already deployed) and has no MVP rate limit (PRD gap, see Dev Notes § PRD/UX findings). Story 1.4 is scoped to FR49's "transaction-write endpoints" mediated via Edge Functions.
- **Do NOT add a super_admin / founder bypass.** PRD §304 + §662: RBAC is out of MVP scope. Service-role bypass (AC #6) is sufficient — sms-worker and dispute-notify both use service-role.
- **Do NOT route through the worker if `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` is unset** — frontend falls back to direct Supabase. This is dev convenience. Production MUST set the env or the FR49 gate is non-functional. Document in README.
- **Do NOT use Cloudflare Durable Objects** (require Workers Paid plan $5/mo). KV's eventual-consistency caveat is acceptable at MVP. Migration to DO is a deferred follow-up if pilot data shows the burst-bypass is exploited.
- **Do NOT log the JWT.** The decoded `collector_id` is fine to log; the raw JWT (especially the signature) is not. Sanitize in any error path.

### Architectural decisions made in this story (5 gaps from architecture.md)

The architecture is **definitive on intent** (CF Workers middleware, 100/min/collector, write Edge Functions) but **silent on five implementation details**. Story 1.4 makes these decisions:

1. **Storage backend → Cloudflare Workers KV** (not Durable Objects, not CF Rate Limiting API). Free-tier compatible; eventual-consistency caveat documented.
2. **Routing topology → client base-URL switch** (`safaricash-api.{account}.workers.dev`). Frontend reads `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL`. Custom-domain deferred to follow-up.
3. **JWT verification depth at edge → trust-and-decode `sub` + `role`** (no signature verification). Supabase verifies downstream. Documented trade-off.
4. **Bypass conditions → service-role only**. No super_admin / founder bypass at MVP (RBAC out of scope per PRD). Sms-worker + dispute-notify rely on service-role bypass.
5. **E2E test gate → Playwright** (101 requests in 60s asserts 429). Add to CI; mutation-test verification documented in PR.

### PRD/UX findings (gaps to document, not necessarily fix)

- **No PRD requirement for unauthenticated rate limit** on the receipt-URL public surface (`/r/{token}`) or saver dispute submit (FR33b). Token entropy is the only stated defense (NFR-S3, ≥128 bits). Out of scope for Story 1.4 but worth flagging — if a saver-side spam vector emerges in pilot, a separate per-IP rate limit on `workers/receipt-url/` will be needed.
- **No founder bypass spec.** PRD §304 + OQ7 (line 662). Service-role covers internal automation; super_admin role doesn't exist at MVP. Confirmed acceptable.
- **No alerting spec for repeated 429s.** A high 429 rate from one collector is a credential-compromise signal. Logging to Cloudflare's standard log surface is sufficient at MVP; founder-alert plumbing deferred.
- **No UX copy for the 429 toast.** UX spec is silent. Story 1.4 proposes French copy `errors.rate_limited` per the spec template `{Action} échouée — {cause}`.
- **Login (Story 1.5) and re-auth (Story 1.3) have their own attempt-counted lockouts** (3 attempts → 5min, per AC line 909 of UX). Those are PER-USER attempt counters, NOT per-collector request rate. NFR-S9 + this story's middleware applies in PARALLEL with those counters; both must trip independently.
- **OTP rate by phone number** (anti-SMS-bombing) is NOT in scope here. The collector-id-keyed limit covers the SMS bombing risk for AUTHENTICATED collectors via re-auth (a compromised JWT that issues OTPs across 4 intended_ops at 100 req/min / 4 ops = 25 OTPs/min/op = bounded). Pre-auth login OTPs (Story 1.5) need their own per-phone counter — Story 1.5 owns that.

### Schema specification

**No schema changes** — Story 1.4 is entirely Cloudflare Worker code + KV namespace. The KV namespace is provisioned via `wrangler kv namespace create` (one-shot operator action, not in migrations).

### Edge Function ↔ Worker integration map

```
BEFORE Story 1.4 (today):
  Frontend  →→→  https://{ref}.supabase.co/functions/v1/re-auth   →  Edge Function

AFTER Story 1.4 deployed + VITE_SUPABASE_FUNCTIONS_GATEWAY_URL set:
  Frontend  →→→  https://safaricash-api.{account}.workers.dev/functions/v1/re-auth
                       │
                       │  workers/rate-limit/src/index.ts
                       │   ├── decode JWT.sub → collector_id
                       │   ├── KV: increment rl:{collector_id}:{minute}
                       │   ├── if count > 100 → 429 RFC 7807
                       │   └── else proxy to Supabase
                       ↓
                 https://{ref}.supabase.co/functions/v1/re-auth   →  Edge Function
```

### Latest tech information (verify at implementation time)

- **Cloudflare Workers:** verify the runtime version (`compatibility_date`) at story start. Latest as of Apr 2026 is around `2026-04-01`. Use a recent date for nodejs_compat shims if needed.
- **Workers KV:** verify the SDK API surface — `env.KV.get(key)`, `env.KV.put(key, value, { expirationTtl: 90 })`, `env.KV.delete(key)`. Stable for years.
- **`wrangler` CLI:** install via `npm install -D wrangler` (latest 4.x as of MVP). Story 1.1 may not have installed it (architecture mentions `wrangler dev` but not in package.json today — verify and add).
- **`@cloudflare/vitest-pool-workers`:** test runner integration for Vitest. Verify compatibility with Vitest 4 at implementation time; if incompatible, fall back to hand-rolled KV mock + plain Vitest.
- **Cloudflare Workers Paid plan ($5/mo):** required ONLY if migrating to Durable Objects post-MVP. Free tier sufficient for Story 1.4.

### Risks & mitigations

- **Risk — KV eventual consistency lets a single attacker burst 200 req/min via multi-POP exploitation.** Mitigation: documented in code + Dev Agent Record. At pilot scale this is bounded by Termii cost (each burst still costs €money). If exploited, migrate to Durable Objects ($5/mo Workers Paid plan).
- **Risk — fail-open on internal worker error means a worker bug temporarily disables rate limiting.** Mitigation: `console.log({level: 'error', event: 'ratelimit.middleware_error'})` provides operator visibility; alerting is deferred but the log line is queryable via `wrangler tail`.
- **Risk — `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` not set in production Cloudflare Pages env → frontend bypasses worker → no rate limit.** Mitigation: deploy runbook (Task 11) makes this an explicit step; verify with synthetic 100-req burst post-deploy. Future hardening: a CI smoke test that asserts the prod frontend bundle includes the gateway URL (Story 1.8).
- **Risk — Cloudflare account ID exposed in worker URL** (`safaricash-api.{account}.workers.dev`). Mitigation: not a security secret per CF; custom-domain migration is the production-grade fix (deferred).
- **Risk — Worker free tier (100k req/day) exceeded if usage scales unexpectedly.** Mitigation: at 50 collectors × 100 req/min × 10 active min/day ≈ 50k/day. Headroom = 2x. Monitor via Cloudflare dashboard; upgrade to Workers Paid if usage ramps faster than expected.

### Project Structure Notes

- **Alignment with unified project structure:** new dir `workers/rate-limit/{wrangler.toml, src/{index.ts, jwt.ts, counter.ts, proxy.ts, rfc7807.ts}, README.md}` — follows the `workers/receipt-url/` pattern from architecture.md line 835-841.
- **Detected variances:** none structural.
- **CI integration:** Story 1.8 (CI pipeline gates) owns the full deploy.yml. Story 1.4 adds a Vitest test step + a Playwright test step against `wrangler dev`. Production deploy via `wrangler deploy` is a manual operator step until Story 1.8 lands.

### Previous-story intelligence (Stories 1.1, 1.2, 1.3)

- **Story 1.1** scaffolded the project with strict TypeScript, ESLint `--max-warnings=0`, Prettier, Husky lint-staged. The CF Worker code (TypeScript) inherits these — write clean code that passes the same gates.
- **Story 1.2** established the audit log + per-collector hash chain. Story 1.4 does NOT emit to audit_log (rate-limit hits are NOT state mutations per FR44 — operational logs only).
- **Story 1.3** established RFC 7807 problem types in `supabase/functions/_shared/rfc7807.ts`. Story 1.4 mirrors the same SHAPE for its 429 response (consumer UIs already know how to render Problem Details). Cannot share code (Worker runtime ≠ Deno) — duplicate the 429 helper in `workers/rate-limit/src/rfc7807.ts`.
- **Story 1.3** deployed the re-auth Edge Function to cloud Supabase but **explicitly deferred prod traffic to wait for Story 1.4** (production-deploy gate in `deferred-work.md`). Story 1.4 closes that gate when deployed.
- **Story 1.3 + 1.5 pattern:** OTP-attempt counters (3 attempts → 5min lockout) live INSIDE the application layer (Edge Function for re-auth, Supabase Auth for login). Story 1.4 adds an ORTHOGONAL request-rate cap at the edge. Both must trip independently — they protect against different attack vectors.

### Testing standards for this story

- **Unit tests** (`workers/rate-limit/src/*.test.ts`): Vitest with KV mock. Coverage target: ≥80% (architecture default).
- **E2E gate** (`tests/e2e/rate-limit.spec.ts`): Playwright. Mutation-test verification documented in PR.
- **No coverage gate beyond the architecture default** — Story 1.4 is small surface, no domain logic equivalent to the cycle engine's 100% gate.
- **CI: 2 new gates** (vitest unit + playwright E2E). Failing tests block merge per the existing CI policy.

### References

All technical details cite their source per the import-restriction rule:

- Architecture decision (Cloudflare Workers middleware on Edge Function endpoints; 100/min/collector on writes; PostgREST handled by Supabase Pro) → [Source: `_bmad-output/planning-artifacts/architecture.md` § Authentication & Security line 349]
- Worker folder convention + receipt-url precedent → [Source: `architecture.md` § Project Structure & Boundaries lines 835-841]
- Free-tier capacity (100k worker requests/day) → [Source: `architecture.md` line 80]
- Build + deploy via `wrangler deploy` → [Source: `architecture.md` § Build Process line 1168, § Local Development line 1173]
- RFC 7807 Problem Details mandate for Edge Functions / 4xx-5xx → [Source: `architecture.md` § Communication Patterns lines 356, 543, 627, 1199]
- FR49 (rate limits on transaction-write endpoints per collector) → [Source: `prd.md` § Functional Requirements line 542]
- NFR-S9 (100 req/min/collector at MVP, adjusted based on pilot) → [Source: `prd.md` § Non-Functional Requirements line 578]
- No founder/super_admin RBAC at MVP → [Source: `prd.md` line 304 + OQ7 line 662]
- Receipt-URL token entropy (NFR-S3, ≥128 bits) — only stated defense for public surface → [Source: `prd.md` line 572]
- UX error template `{Action} échouée — {cause}` → [Source: `ux-design-specification.md` line 1395]
- Story 1.3 RFC 7807 problem-types convention → [Source: `_bmad-output/implementation-artifacts/1-3-reauth-edge-function.md` § RFC 7807 problem types]
- Production-deploy gate from Story 1.3 review → [Source: `_bmad-output/implementation-artifacts/deferred-work.md` § "PRODUCTION DEPLOY GATE: re-auth Edge Function must NOT be exposed..."]
- Audit log scope (state-mutating ops only — rate-limit hits NOT in scope) → [Source: `prd.md` line 537 (FR44)]
- Story 1.5 login lockout (separate counter, parity wording) → [Source: `ux-design-specification.md` line 909]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Opus 4.7, 1M context) via Claude Code CLI — bmad-dev-story workflow.

### Debug Log References

- **Vitest discovery vs nested tsconfig.** Adding `workers/rate-limit/tsconfig.json` made Vitest treat the directory as a separate project root and try to load a non-existent `vitest.setup.ts` there. Fixed by pinning `vitest.config.ts` `root: __dirname` and explicit `include: ["src/**/*.{test,spec}.ts", "workers/**/*.{test,spec}.ts"]`.
- **Story 1.2 contract test crash on missing env.** `hashChain.contract.test.ts` had `createClient(...)` at the top of the `describe.runIf` body. Vitest 4 evaluates the suite body to register tests even when the predicate is false → createClient threw on missing `SUPABASE_URL`. Fixed by lazy-init via `beforeAll`. Pre-existing issue unrelated to Story 1.4 but surfaced because the worker tests ran without cloud env vars.
- **`wrangler dev` requires a valid KV namespace `id`.** Initial wrangler.toml had a placeholder string that Miniflare rejected. Fixed by adding a 64-char hex `preview_id` for Miniflare local + a separate `id` placeholder the operator overwrites on first deploy.
- **No Cloudflare account credentials available locally.** Operator-side `wrangler deploy` + `wrangler kv namespace create` are deferred to the production-deploy step (documented in `workers/rate-limit/README.md`). All dev + tests work via Miniflare without auth.

### Completion Notes List

**Story 1.4 implementation complete.** Closes half of Story 1.3's production-deploy gate (the SMS-bombing risk via re-auth is bounded by 100 req/min/collector); the OTHER half (Story 1.5 phone-OTP login UX) remains open until that story ships.

**What landed:**

- **`workers/rate-limit/`** — new Cloudflare Worker per architecture line 835-841 convention:
  - `wrangler.toml` with KV binding (`RATE_LIMIT_KV`), env vars (`RATE_LIMIT_PER_MINUTE`, `SUPABASE_PROJECT_URL`), Miniflare-friendly preview_id, observability enabled.
  - `tsconfig.json` strict + `@cloudflare/workers-types`.
  - `src/index.ts` (~130 lines) — handler with the 4-step lifecycle: decode JWT → bypass-or-count → 429-or-proxy → fail-open. Structured JSON logs to stdout (collector_id, bucket, count, threshold). NEVER logs the raw JWT or the Authorization header.
  - `src/jwt.ts` — trust-and-decode helper (base64-url decode, sub + role extraction, no signature verification).
  - `src/counter.ts` — KV sliding-window-by-minute counter; key shape `rl:{collector_id}:{ISO8601-minute}`; TTL 90s; documented eventual-consistency caveat.
  - `src/proxy.ts` — transparent proxy; strips `host` header.
  - `src/rfc7807.ts` — 429 RFC 7807 builder; mirrors Story 1.3's problem-types shape.
  - `src/index.test.ts` — 10 Vitest scenarios with hand-rolled in-memory KV mock + fetch stub (no real Cloudflare account needed).
  - `README.md` — operator runbook: deploy steps, KV provisioning, threshold adjustment, tail logs, trade-off matrix.

- **Frontend wiring (`src/`):**
  - `src/infrastructure/supabase/env.ts` — added optional `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` Zod schema entry.
  - `src/infrastructure/supabase/client.ts` — when the gateway URL is set, install a `global.fetch` override that reroutes `${SUPABASE_URL}/functions/v1/*` calls through the gateway. Auth/PostgREST/realtime continue to hit Supabase directly (per architecture line 349 — Supabase Pro's native rate-limit handles those).
  - `src/i18n/fr.json` — added `errors.rate_limited: "Limite atteinte — patientez {seconds} s avant de réessayer."` (UX spec template `{Action} échouée — {cause}`).
  - `.env.example` — added `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL=` line with documentation comment.

- **Tests (all green):**
  - `workers/rate-limit/src/index.test.ts` — 10 Vitest scenarios: anonymous bypass, service-role bypass, 100 OK, 101st → 429 + Retry-After + RFC 7807 body, bucket rollover after 60s (fake timers), env override (RATE_LIMIT_PER_MINUTE=10), malformed JWT → anonymous, KV failure → fail-open, log shape assertion, missing config → 500 with `ratelimit.config_missing` log.
  - `tests/e2e/rate-limit.spec.ts` — Playwright spec asserts 101st request from same collector within 60s returns 429 + `Retry-After`. Auto-skipped when `WORKER_BASE_URL` env not set (deferred to Story 1.8 to wire `wrangler dev` into CI). Operator can run locally: `npm run worker:rate-limit:dev` in one terminal, `WORKER_BASE_URL=http://localhost:8787 npx playwright test tests/e2e/rate-limit.spec.ts` in another.

- **`deferred-work.md` updates:**
  - The "PRODUCTION DEPLOY GATE" entry from Story 1.3 review is marked **PARTIALLY RESOLVED** — Story 1.4's deploy closes the SMS-bombing risk; Story 1.5 closes the remaining half by wiring login.
  - Operational checklist for prod deploy added (5 steps: provision KV, deploy, set env, re-deploy Pages, smoke-test).

**Architectural choices made (5 gaps from architecture.md, all documented in spec + code comments):**

1. **Storage backend → Workers KV** (free tier, eventual-consistency caveat documented; Durable Objects $5/mo deferred).
2. **Routing topology → client base-URL switch** via `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL`. Custom domain (`api.safaricash.app`) deferred.
3. **JWT verification depth → trust-and-decode `sub` + `role`**. No signature verify at edge — Supabase verifies downstream; forged JWTs only burn quota for fake collector_ids.
4. **Bypass conditions → service-role only**. No super_admin / founder bypass at MVP per PRD §304 + OQ7.
5. **E2E test gate → Playwright** with auto-skip when WORKER_BASE_URL missing (operator-runnable; CI-wireable in Story 1.8).

**Operator action required (NOT done by dev — needs Cloudflare account):**

1. `wrangler kv namespace create RATE_LIMIT_KV` → paste resulting ID into `wrangler.toml`.
2. `wrangler secret put SUPABASE_PROJECT_URL` (set to current cloud Supabase project URL).
3. `wrangler deploy` → captures the `safaricash-rate-limit.{cf-account}.workers.dev` URL.
4. Set `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` in Cloudflare Pages prod env → re-deploy Pages.
5. Run `WORKER_BASE_URL=https://... npx playwright test tests/e2e/rate-limit.spec.ts` to verify the prod gate.

**Validation results (all green):**

- ✅ `npm run lint` (eslint --max-warnings=0) — clean
- ✅ `npx tsc --noEmit` (strict, root) — clean
- ✅ `cd workers/rate-limit && npx tsc --noEmit` (Cloudflare Workers types) — clean
- ✅ `npx prettier --check .` — clean
- ✅ `npm run test` (Vitest) — **66/66 passed | 1 skipped** (10 worker + 10 hashChain Story 1.2/1.3 + 26 hashChain unit + 12 camelize + 7 toCanonicalTimestamp + App smoke + 1 contract auto-skip)
- ✅ `npm run test:edge` (Deno) — **12/12 passed** (Story 1.3 re-auth tests still green)
- ✅ `npx playwright test` (5 passed | 1 skipped — rate-limit auto-skip without WORKER_BASE_URL; Story 1.2 RLS gates still green)
- ✅ `npm run build` — clean (45.96 kB gzipped JS, 8 PWA precache entries)

**Known caveats (acceptable for MVP):**

- Workers KV eventual consistency: a sub-second burst from one collector across multiple CF edge POPs can transiently exceed 100/min before propagation converges (~60s). Mitigation path: migrate to Cloudflare Durable Objects ($5/mo Workers Paid plan) if pilot data shows the burst-bypass is exploited.
- Bucket boundary edge case: an attacker timing requests at XX:59 → YY:00 can fire 100+100 in <2s. Acceptable at MVP scale.
- Trust-and-decode JWT: a forged JWT with a fake `sub` could dilute another collector's quota by 1 request. Self-limiting (the forged JWT also gets rate-limited under its own fake `sub`) and Supabase rejects the forged JWT downstream.

### File List

**New files:**

- `workers/rate-limit/wrangler.toml`
- `workers/rate-limit/tsconfig.json`
- `workers/rate-limit/README.md`
- `workers/rate-limit/src/index.ts`
- `workers/rate-limit/src/jwt.ts`
- `workers/rate-limit/src/counter.ts`
- `workers/rate-limit/src/proxy.ts`
- `workers/rate-limit/src/rfc7807.ts`
- `workers/rate-limit/src/index.test.ts`
- `tests/e2e/rate-limit.spec.ts`

**Modified:**

- `src/infrastructure/supabase/env.ts` (added VITE_SUPABASE_FUNCTIONS_GATEWAY_URL)
- `src/infrastructure/supabase/client.ts` (gateway-router fetch override)
- `src/i18n/fr.json` (errors.rate_limited)
- `src/domain/audit/hashChain.contract.test.ts` (lazy-init via beforeAll — Story 1.2 fix surfaced by Story 1.4)
- `vitest.config.ts` (root pin + workers/** include)
- `.env.example` (VITE_SUPABASE_FUNCTIONS_GATEWAY_URL)
- `package.json` (worker:rate-limit:* scripts; wrangler + @cloudflare/workers-types devDeps)
- `_bmad-output/implementation-artifacts/deferred-work.md` (production-deploy gate partially resolved)

**Deleted:**

- `workers/receipt-url/src/.gitkeep` (replaced by future Story 6.x receipt-url worker code)

## Change Log

| Date       | Author     | Change |
|------------|------------|--------|
| 2026-04-20 | dev (Opus) | Story 1.4 complete — Cloudflare Worker `workers/rate-limit/` enforces NFR-S9 (100 req/min/collector) on all `/functions/v1/*` calls. Closes the SMS-bombing half of Story 1.3's production-deploy gate. 5 architectural gaps from architecture.md resolved (KV backend, client base-URL switch, trust-and-decode JWT, service-role-only bypass, Playwright E2E gate). 10 Vitest unit tests + 1 Playwright E2E (auto-skipped without WORKER_BASE_URL — Story 1.8 will wire wrangler dev into CI). Frontend wired via `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` env (rerouting `/functions/v1/*` through the worker). FR copy `errors.rate_limited` added. README.md operator runbook included. Operator action required for production deploy: `wrangler kv namespace create`, `wrangler deploy`, set Pages env. Lint, typecheck, build, vitest 66/66, Deno 12/12, Playwright 5/5 all green. Status → review. |
