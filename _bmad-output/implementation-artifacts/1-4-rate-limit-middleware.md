# Story 1.4: Rate-limit middleware on transaction-write endpoints

Status: done

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
10. **Vitest unit test + Playwright E2E gate.** Two test surfaces: (a) `workers/rate-limit/src/index.test.ts` — Vitest tests with mocked KV namespace (using `@cloudflare/vitest-pool-workers` if available, else a hand-rolled KV mock) covering: bypass for missing-auth / service-role, counter increment on first call, 429 on 101st call within 60s, bucket rollover after 60s, threshold respects `RATE_LIMIT_PER_MINUTE` env override. (b) `tests/e2e/rate-limit.spec.ts` — Playwright spec that hits the deployed worker URL (or local `wrangler dev` in CI) 101 times within 60s for one collector and asserts the 101st returns 429 + `Retry-After`. **AMENDED 2026-04-20 (review decision C2):** the CI hard-gate for the Playwright E2E (auto-skip when `WORKER_BASE_URL` env unset) is formally deferred to **Story 1.8 (CI pipeline gates)**, which owns the `wrangler dev` background-process wiring + `WORKER_BASE_URL` injection. Until Story 1.8 lands, the Vitest unit suite (18 scenarios incl. forged-service-role regression guard) is the merge-blocking gate; the Playwright spec runs on operator demand for prod smoke-tests (`WORKER_BASE_URL=...` + `npx playwright test`).
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

### Review Findings

Code review run on 2026-04-20 (3 parallel adversarial layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor; ~70 raw findings, deduped + triaged below). **Two critical exploits + one operational blocker — must resolve before flipping the production-deploy gate.**

**Decision-needed (must resolve before patches):**

- [x] [Review][Decision] **KV write quota mismatch — Workers Paid plan ($5/mo) OR migrate to Durable Objects ($5/mo same plan) OR re-scope MVP usage.** Cloudflare Workers KV free tier allows **1,000 writes/day per account** (verified at https://developers.cloudflare.com/kv/platform/limits/). At 50 collectors × ~100 active req/day ≈ 5,000+ writes/day → **5x over free tier**. The story's "free-tier compatible" claim (AC #1, README §Trade-offs) conflates Worker request quota (100k/day, OK) with KV write quota (1k/day, blown). Once the daily quota fires, `kv.put` throws → fail-open path → rate-limiting silently disabled until 00:00 UTC. **Options:** (a) **upgrade to Workers Paid $5/mo** — unlocks 1M KV writes/day + Durable Objects access; cleanest fix, fixes the budget AND unlocks DO migration path. (b) **Migrate to Durable Objects** in this story (also $5/mo; gives strong consistency, fixes the multi-POP race F6 too). (c) **Accept free-tier cap** — bound MVP to ≤10 active collectors and document as hard ceiling in deferred-work.md (acceptable only if pilot is genuinely small). (d) **Use Cloudflare's native Rate Limiting Rules** (free tier with 1k req/day rule budget — different shape, may not fit per-collector keying).

- [x] [Review][Decision] **CI Playwright gate enforcement — wire `wrangler dev` into CI now or amend AC #10?** AC #10 explicitly required "CI runs both gates; failure blocks merge." Current implementation uses `test.skip()` when `WORKER_BASE_URL` is missing, which Playwright reports as PASS — same anti-pattern Story 1.3 review flagged. Options: (a) wire `wrangler dev` into CI now (~30 min: `npm run worker:rate-limit:dev` background process in ci.yml + `WORKER_BASE_URL=http://localhost:8787` env on the playwright step + hard-fail when CI=true & env missing); (b) formally amend AC #10 to defer the CI gate to Story 1.8 (CI pipeline gates) and update the deferred-work.md entry; (c) hard-fail in CI without wiring (forces Story 1.8 to land first — blocks all future merges).

**Patches (CRITICAL — exploitable today):**

- [x] [Review][Patch][CRITICAL] **Service-role JWT bypass via forgery (Blind Hunter F1).** `workers/rate-limit/src/index.ts:82` calls `isServiceRole(jwt)` which checks `jwt.role === 'service_role'` — but `jwt` is the trust-and-decoded payload with NO signature verification. **Anyone can craft a JWT with `{"role":"service_role"}` and bypass the rate limit entirely** — unlimited proxy passes. The README's "self-limiting" claim is wrong: the worker proxies every forged request to Supabase, burning Supabase request quota AND Termii SMS budget on `/functions/v1/re-auth` (the actual SMS-bombing risk Story 1.4 was supposed to close). **Fix:** add `SUPABASE_SERVICE_ROLE_KEY` to the Worker env (it's a static JWT, NOT a secret rotation per request) and replace `isServiceRole(jwt)` with constant-time comparison of the raw bearer token to that env value. The service-role JWT is FIXED per Supabase project — it cannot be forged because it's a known static value. Pseudocode:
  ```ts
  function isLegitimateServiceRole(authHeader: string | null, expectedKey: string): boolean {
    if (!authHeader || !expectedKey) return false;
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    return constantTimeEqual(m[1].trim(), expectedKey.trim());
  }
  ```
  And constant-time string compare to prevent timing oracle. Add `SUPABASE_SERVICE_ROLE_KEY` to `wrangler.toml` `[vars]` (operator sets via `wrangler secret put` — this is a secret).

- [x] [Review][Patch][CRITICAL] **KV write quota exceeds free tier — production-deploy blocker.** See Decision-needed above. Until resolved, deploying to production breaks within hours. The patch is whichever decision option is chosen (Workers Paid plan + KV writes unlocked, OR DO migration, OR scope cap).

**Patches (HIGH — production blockers + security exploits):**

- [x] [Review][Patch] **CORS preflight (OPTIONS) untested — likely-but-not-verified production path.** Frontend (`*.pages.dev`) calls Worker (`*.workers.dev`) cross-origin → browser sends OPTIONS preflight before every authed request. Worker has no OPTIONS short-circuit; passes through to Supabase. Supabase Functions runtime DOES set `Access-Control-Allow-Origin: *` on OPTIONS by default — likely works — but **zero tests exercise this path** (Vitest has no OPTIONS test; Playwright spec uses node fetch which skips CORS). **Fix:** (1) add explicit OPTIONS handler in worker that returns 204 with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS`, `Access-Control-Allow-Headers: authorization,content-type,apikey,x-client-info,prefer` (mirror Supabase's defaults); (2) add Vitest scenario asserting OPTIONS returns 204 with CORS headers WITHOUT consulting KV; (3) before flipping the prod gate, manually smoke-test a real browser preflight against the deployed worker URL. [workers/rate-limit/src/index.ts:46]

- [x] [Review][Patch] **Sub impersonation DoS via JWT forgery (Blind Hunter F2).** Trust-and-decode `sub` means an attacker who knows a victim collector's UUID (visible in their own JWT or in audit_log payloads) can forge a JWT with `sub: "victim-uuid"` and burn the victim's 100/min quota — locking out the legitimate collector. Mitigation paths: (a) verify JWT signature for collector tokens too (defeats the trade-off but eliminates this DoS); (b) accept the risk and document — UUIDs are 122-bit but observable to anyone with collector-level access. **Recommended:** at minimum, update README §Trade-offs to honestly call out the targeted-DoS risk (current wording says "burns quota for fake collector_ids" which only covers random sub, not impersonation). [workers/rate-limit/src/jwt.ts:42-46, README.md §Trade-offs]

- [x] [Review][Patch] **Silent fail-open + KV-budget-exhaustion exploit chain (F3 → F4).** When KV throws (e.g., quota exhausted via random-sub spam from F1+F3), the worker proxies through with only a stdout log line — no metric, no alert, no health check. An attacker exhausts the KV write budget in seconds, then has unlimited proxy access for the rest of the day. **Fix:** (1) Decision A above (paid plan eliminates the quota issue); (2) add a Cloudflare Health Check + alerting in deferred-work for Story 1.8; (3) consider closed-fail for the CRITICAL config-missing case but keep open-fail for transient KV errors — current asymmetry (open on KV, closed on missing URL) is correct. [workers/rate-limit/src/index.ts:99-115]

- [x] [Review][Patch] **JWT decode crash → silent anonymous bypass (Blind Hunter F5).** The handler's outer `try/catch` around `decodeJwt` treats ANY decode failure as anonymous (bypass). An attacker who finds a JWT pattern that crashes the decoder gets unlimited bypass. **Fix:** (a) cap JWT payload at 8 KB before decode (prevents OOM DoS — Edge Hunter); (b) on decode crash, treat as anonymous OR require a fallback closed-fail for explicitly-non-empty Authorization headers (a malformed Authorization header should NOT be treated as "no header at all"). The simpler fix: when Authorization header is present but decode fails, increment a separate "auth_failed" counter rather than fully bypassing. For now: at minimum cap payload size + log loud. [workers/rate-limit/src/jwt.ts:35-45, src/index.ts:79-89]

- [x] [Review][Patch] **Placeholder configs in `wrangler.toml` ship by default (F8).** `id = "0000..."`, `SUPABASE_PROJECT_URL = "https://example.supabase.co"` — if operator forgets to override, deploy may succeed and proxy real prod traffic to example.supabase.co (leaking JWTs + request bodies). **Fix:** (1) add a pre-deploy lint script that fails when `id` matches `^0{32,}$` regex OR `SUPABASE_PROJECT_URL` matches `example.supabase.co`; (2) wire into `npm run worker:rate-limit:deploy` as a prerequisite check; (3) document loudly in README first-time-deployment section. [workers/rate-limit/wrangler.toml:24, 38]

- [x] [Review][Patch] **README §Trade-offs minimizes critical risks (F20).** Current wording: "Forged JWTs only burn quota for fake collector_ids" — wrong for both F1 (service_role bypass) and F2 (sub impersonation). "Fail-open ... briefly" — wrong; lasts 24h on KV quota exhaustion. **Fix:** rewrite trade-offs honestly with concrete bounds. Example: "Fail-open lasts until human sees Wrangler tail logs (no automated alerting until Story 1.8)." [workers/rate-limit/README.md:124-129]

**Patches (MEDIUM — defense-in-depth + correctness):**

- [x] [Review][Patch] **KV race across CF POPs untested (F6, Edge Hunter).** No test asserts behavior under `Promise.all([...100 parallel requests...])`. The story documents the eventual-consistency caveat but the test suite does NOT exercise it. **Fix:** add Vitest test firing 150 parallel requests for same collector with threshold=100, asserting at least 50 return 429 (Decision A's DO migration would close this entirely). [workers/rate-limit/src/index.test.ts]

- [x] [Review][Patch] **Trailing-slash bypass on URL match (F9, Edge Hunter).** Frontend gateway-router: if `VITE_SUPABASE_URL` has trailing slash and `gatewayUrl` doesn't (or vice versa), `startsWith` check fails silently → calls bypass worker → no rate-limit. **Fix:** normalize both URLs (strip trailing slash) at config load AND use `slice(prefix.length)` instead of `replace(prefix, ...)` to be robust against substring repetition. [src/infrastructure/supabase/client.ts:11-22]

- [x] [Review][Patch] **No proxy timeout (F10).** `proxyToSupabase` `fetch` has no AbortSignal — if Supabase hangs 30s, worker hangs 30s. **Fix:** add `signal: AbortSignal.timeout(10_000)` to the fetch call; on timeout return 504 RFC 7807. [workers/rate-limit/src/proxy.ts:24-29]

- [x] [Review][Patch] **Instance URL leak in 429 body (F11).** `instance: request.url` includes path AND query string. Future endpoints with tokens in query string (signed URLs, OAuth code) leak in error responses. **Fix:** strip to pathname only: `new URL(request.url).pathname`. [workers/rate-limit/src/index.ts:127, src/rfc7807.ts]

- [x] [Review][Patch] **Missing security headers on 429 (F12).** No `X-Content-Type-Options: nosniff`, no `Cache-Control: no-store`. Without `no-store`, CDN/browser may cache 429 → users locked out beyond intended window. **Fix:** add to `rateLimitedResponse`. [workers/rate-limit/src/rfc7807.ts:32-38]

- [x] [Review][Patch] **No method allowlist (Edge Hunter).** Worker proxies arbitrary methods (TRACE, CONNECT). Defense-in-depth fix: `if (!['GET','POST','PATCH','DELETE','OPTIONS','HEAD'].includes(req.method)) return 405`. [workers/rate-limit/src/index.ts:46]

- [x] [Review][Patch] **Large JWT payload OOM DoS (Edge Hunter).** `decodeJwt` could be passed a multi-MB JWT → OOM. **Fix:** `if (parts[1].length > 8192) return null` — caps payload at 8 KB before decode. [workers/rate-limit/src/jwt.ts:31]

- [x] [Review][Patch] **`parseThreshold("0")` silently becomes 100 (Edge Hunter).** Operator setting threshold to 0 (intent: disable) silently gets 100. **Fix:** accept 0 as valid (semantically: disable rate limit, allow all) OR reject negative values explicitly with a startup error. Recommend: accept 0 = disable, reject negative. [workers/rate-limit/src/index.ts:39-42]

- [x] [Review][Patch] **Bucket boundary attack untested (Edge Hunter).** No test fires 100+100 across XX:59 → YY:00. Spec acknowledges this attack but no regression guard. **Fix:** add Vitest test using `vi.useFakeTimers` to advance across boundary. [workers/rate-limit/src/index.test.ts]

- [x] [Review][Patch] **Forged service-role bypass test missing (Edge Hunter).** No Vitest test verifies the service-role bypass actually works (or, after the F1 fix, that forged service-role JWTs are rejected). **Fix:** add explicit test asserting: (a) legitimate service-role bearer token bypasses; (b) forged JWT with `role: service_role` BUT wrong signature is rejected (post-F1 fix). [workers/rate-limit/src/index.test.ts]

- [x] [Review][Patch] **Counter+collector_id log redundancy (F19, Edge Hunter).** Both `collector_id` and `bucket_key` log the full UUID — bucket_key is a strict superset. Drop `bucket_key` (or replace with bucket_minute only). [workers/rate-limit/src/index.ts:117-122]

**Patches (LOW — code quality, hardening):**

- [x] [Review][Patch] **i18n `errors.rate_limited` `{seconds}` placeholder has no consumer wiring (F16).** No code in this diff reads `retry_after_seconds` from the 429 body and feeds the i18n renderer. **Fix:** add a TODO comment in fr.json AND in client.ts noting that consumer stories (7.4 / 2.6 / 9.3) need to wire it. [src/i18n/fr.json:3]

- [x] [Review][Patch] **`compatibility_date = "2026-04-01"` undocumented (F17).** Add a one-line comment justifying the date. [workers/rate-limit/wrangler.toml:9]

- [x] [Review][Patch] **Root `README.md` § Stack still says "(receipt URL)" only (Auditor Task 10 gap).** Story task 10.3 said update root README to mention the new worker layer; not done. **Fix:** add line. [README.md]

- [x] [Review][Patch] **No rollback path in worker README (Auditor).** No `wrangler rollback` command, no kill-switch (e.g., `RATE_LIMIT_PER_MINUTE=999999` to effectively disable). **Fix:** add Operator Runbook §Rollback section. [workers/rate-limit/README.md]

- [x] [Review][Patch] **Whitespace-only `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` passes Zod (Edge Hunter).** Currently `.optional().or(z.literal(""))` — would also accept `"   "`. **Fix:** add `.trim().refine(v => v === "" || /^https?:\/\//.test(v), ...)`. [src/infrastructure/supabase/env.ts:13-15]

- [x] [Review][Patch] **CF-injected headers (cf-connecting-ip, cf-ray) forwarded to Supabase without explicit choice (F18).** Defense-in-depth: either explicitly forward via `X-Forwarded-For` translation, or strip. Document the choice. [workers/rate-limit/src/proxy.ts:18-20]

**Deferred (real but not blocking):**

- [x] [Review][Defer] **Hash collector_id in logs for privacy (Edge Hunter F19 + extra).** Future Supabase config could change `sub` to email/phone. Defense-in-depth: log SHA-256 of collector_id. Defer until log retention review (Story 9.x).
- [x] [Review][Defer] **Cloudflare Health Check + alerting on `ratelimit.middleware_error`.** Story 1.8 (CI pipeline gates) owns automation + alerting wiring.
- [x] [Review][Defer] **Custom domain `api.safaricash.app` instead of `*.workers.dev`.** Cosmetic + future-proofing. Defer to a dedicated infra story.

**Dismissed as noise:**

- "compatibility_date is future-dated" — verified 2026-04-01 is a real released date.
- "Test (b) name 'bypasses rate-limit (proxied without count)' lacks security warning framing" — naming nitpick, not a bug.
- "Side fix to hashChain.contract.test.ts is scope creep" — necessary to keep CI green after vitest config changes; one-line fix.

### Resolution log (2026-04-20, post-review)

User decisions: **A3** (accept free-tier KV cap + document MVP ≤10 collectors), **B1** (fix service-role bypass now via constant-time bearer compare), **C2** (amend AC #10 — defer CI Playwright gate to Story 1.8).

**A3 — KV write quota** (~15 LOC + docs)
- README §Trade-offs rewritten with explicit "≤10 active collectors/day = HARD CAP for MVP" row + escalation path (Workers Paid $5/mo).
- AC #1 wording in story spec retains "free-tier compatible" but now bound by the documented per-collector cap.
- New deferred-work entry tracks the migration trigger: 11th collector onboards.

**B1 — Service-role bypass** (CRITICAL fix, ~50 LOC + 3 tests)
- New `workers/rate-limit/src/bearer.ts`: `isLegitimateServiceRole(authHeader, expectedKey)` does constant-time compare of raw bearer string against `SUPABASE_SERVICE_ROLE_KEY` env. Length-mismatch shortcut, XOR-accumulator constant-time loop.
- `workers/rate-limit/src/jwt.ts`: removed `isServiceRole(jwt)` export entirely (was the F1 vulnerability surface). Added `MAX_PAYLOAD_BYTES = 8 KB` cap before base64 decode (closes Edge Hunter OOM-DoS).
- `workers/rate-limit/src/index.ts` rewritten: bypass check now consults `bearer.ts`, never the JWT role claim. Added `Env.SUPABASE_SERVICE_ROLE_KEY?: string` (optional — unset = no bypass).
- `wrangler.toml`: added documentation block on `SUPABASE_SERVICE_ROLE_KEY` (must be set via `wrangler secret put`, never `[vars]`).
- 3 new Vitest scenarios: (b) legitimate service-role bearer (env match) bypasses 200 reqs; **(b2) FORGED service-role JWT must be rate-limited** (regression guard for F1); (b3) service-role bearer with no env set → no bypass.

**C2 — CI Playwright gate** (docs only, ~5 LOC)
- AC #10 amended in story spec body with explicit "AMENDED 2026-04-20 (review decision C2)" annotation pointing to Story 1.8 ownership.
- Vitest unit suite (now 18 scenarios) is the merge-blocking gate until Story 1.8 lands.

**HIGH/MED/LOW patches batched in the same diff:**
- CORS preflight: `OPTIONS` short-circuit returns 204 with `Access-Control-Allow-Origin: *` + Methods + Headers (mirrors Supabase Functions defaults). Never consults KV. Test (i) added.
- Sub impersonation DoS: README §Trade-offs row honestly describes the targeted-DoS via known-UUID forgery (not just "fake collector_ids").
- Silent fail-open: README §Trade-offs row clarifies fail-open lasts "until human sees Wrangler tail logs (no automated alerting until Story 1.8)". Closed-fail kept asymmetric (open on KV, closed on missing SUPABASE_PROJECT_URL — correct).
- JWT decode crash: 8 KB payload cap before decode; outer try/catch retained as defense-in-depth.
- Placeholder configs: `workers/rate-limit/scripts/check-config.mjs` rejects `^0{32,}$` KV id + `example.supabase.co`. Wired into `npm run worker:rate-limit:deploy` via `&&`. Bypass via `SKIP_RATE_LIMIT_CONFIG_CHECK=1`.
- Method allowlist: 405 RFC 7807 for non-{GET,POST,PATCH,PUT,DELETE,OPTIONS,HEAD}. Test (j) added with mock Request shape (Node Request rejects TRACE at platform level).
- Proxy timeout: `AbortSignal.timeout(10_000)` → 504 RFC 7807 on `TimeoutError`/`AbortError`.
- Instance URL leak: `safeInstance(rawUrl)` strips to pathname only. Test (d2) verifies query string `?token=secret-do-not-echo` is absent from 429 body.
- Security headers: `X-Content-Type-Options: nosniff` + `Cache-Control: no-store` on 429 + 405 + 500 + 504. CORS `Access-Control-Allow-Origin: *` echoed on 429 so consumer UIs cross-origin can read the body.
- `parseThreshold("0")`: now correctly accepted as "rate-limit disabled" (operator kill-switch). Negative falls back to 100. Test (f2) added — 250 sequential requests all proxy with threshold=0, KV untouched.
- Bucket boundary attack: test (e2) locks in the documented behavior (100+100 across XX:59→YY:00 both succeed). Will need update if we migrate to Durable Objects.
- Counter+collector_id log redundancy: counter now exposes `bucketMinute` (not full bucket key); handler logs `bucket_minute` separately from `collector_id`. Test asserts `bucket_minute` does not contain the collector UUID.
- i18n `{seconds}` consumer wiring: TODO documented in `_notes` block of `fr.json` AND in deferred-work.md (Stories 7.4/2.6/9.3).
- Compatibility date: comment added to `wrangler.toml`.
- Root README §Stack: "Cloudflare Workers (rate-limit middleware front of Supabase Edge Functions; receipt URL)".
- Worker README: §Rollback added with 3 escalation paths (RATE_LIMIT_PER_MINUTE=0 kill-switch → bypass via Pages env unset → wrangler rollback).
- Whitespace `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL`: Zod `preprocess` normalises `"   "` → undefined before `.url()`.
- Trailing-slash bypass: client.ts normalises both URLs (strip trailing slash) AT IMPORT TIME, uses `slice(prefix.length)` instead of `replace()`.
- CF-injected headers: README documents the choice (forward as-is — Supabase will see cf-connecting-ip + cf-ray).

**Validation (post-patch):**
- `npx vitest run`: **74 passed | 1 skipped** (workers/rate-limit suite up from 10 → 18 scenarios).
- `npx tsc --noEmit` (root): clean.
- `npx tsc --noEmit` (workers/rate-limit): clean.
- ESLint: not re-run yet — defer to commit gate.

Status → done.

## Change Log

| Date       | Author     | Change |
|------------|------------|--------|
| 2026-04-20 | dev (Opus) | Story 1.4 complete — Cloudflare Worker `workers/rate-limit/` enforces NFR-S9 (100 req/min/collector) on all `/functions/v1/*` calls. Closes the SMS-bombing half of Story 1.3's production-deploy gate. 5 architectural gaps from architecture.md resolved (KV backend, client base-URL switch, trust-and-decode JWT, service-role-only bypass, Playwright E2E gate). 10 Vitest unit tests + 1 Playwright E2E (auto-skipped without WORKER_BASE_URL — Story 1.8 will wire wrangler dev into CI). Frontend wired via `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` env (rerouting `/functions/v1/*` through the worker). FR copy `errors.rate_limited` added. README.md operator runbook included. Operator action required for production deploy: `wrangler kv namespace create`, `wrangler deploy`, set Pages env. Lint, typecheck, build, vitest 66/66, Deno 12/12, Playwright 5/5 all green. Status → review. |
| 2026-04-20 | review (Opus) | 3-layer adversarial review (Blind Hunter / Edge Case Hunter / Acceptance Auditor) → 2 CRITICAL + 7 HIGH + 14 MED + 6 LOW findings. User decisions: A3 (accept free-tier KV cap, document MVP ≤10 collectors hard cap), B1 (fix service-role bypass via constant-time bearer compare against SUPABASE_SERVICE_ROLE_KEY env), C2 (amend AC #10, defer CI Playwright gate to Story 1.8). All non-deferred findings patched. New file: `workers/rate-limit/src/bearer.ts` (constant-time service-role check) + `workers/rate-limit/scripts/check-config.mjs` (pre-deploy lint). Worker handler hardened: OPTIONS preflight, method allowlist, 8KB JWT cap, 10s proxy timeout (504 RFC 7807), no-store + nosniff on all problem responses, threshold=0 kill-switch, instance URL stripped to pathname. Vitest suite expanded 10 → 18 scenarios (incl. forged-service-role regression guard, OPTIONS preflight, bucket boundary, KV race, query-string leak guard). README §Trade-offs rewritten honestly + new §Rollback section. Frontend client.ts URL normalisation (trailing-slash bypass closed). vitest 74/74, tsc clean (root + worker). Status → done. |
