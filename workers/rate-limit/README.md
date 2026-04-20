# `workers/rate-limit/` — SafariCash rate-limit middleware

Cloudflare Worker that fronts Supabase Edge Functions and enforces NFR-S9
(100 req/min/collector). Story 1.4 implementation.

## What it does

```
React PWA  →→→  this Worker  →→→  Supabase Edge Functions
                    │
                    ├── OPTIONS preflight → 204 + CORS headers (no KV consult)
                    ├── method allowlist (GET/POST/PATCH/PUT/DELETE/OPTIONS/HEAD)
                    ├── bearer == SUPABASE_SERVICE_ROLE_KEY (constant-time) → bypass
                    ├── decode JWT.sub → collector_id (no signature verify)
                    ├── KV: increment rl:{collector_id}:{minute}
                    ├── if count > 100 → 429 RFC 7807 + Retry-After
                    ├── if anonymous (no JWT) → bypass
                    ├── if KV down OR internal error → fail-OPEN (proxy)
                    ├── if RATE_LIMIT_PER_MINUTE=0 → bypass (kill-switch)
                    └── else → proxy to Supabase
```

- **Anonymous (no JWT)** → bypass; Supabase Pro's native limits handle it.
- **Service-role bearer** → bypass IFF the bearer token equals the static
  `SUPABASE_SERVICE_ROLE_KEY` env (constant-time compare). The `role:
"service_role"` claim in the JWT payload is **NEVER trusted** — it is
  trivially forgeable since the worker doesn't verify signatures.
- **Collector JWT** → counted via Workers KV sliding window per minute.
- **Internal error (KV outage, etc.)** → fail-open; logs `ratelimit.middleware_error`.

The 429 response is RFC 7807 + standard `Retry-After` header; matches the
shape Story 1.3 established for the re-auth Edge Function.

## Local development

```bash
npm run worker:rate-limit:dev      # wrangler dev on http://localhost:8787 (Miniflare KV)
npm run worker:rate-limit:tail     # tail logs of the deployed worker
```

`wrangler dev` uses Miniflare's local KV (the `preview_id` in
`wrangler.toml`) — no Cloudflare account needed for development or unit
tests.

## First-time deployment (operator)

`npm run worker:rate-limit:deploy` runs `scripts/check-config.mjs` first;
it refuses to deploy if `wrangler.toml` still contains the placeholder
KV id (`0000…`) or `SUPABASE_PROJECT_URL=https://example.supabase.co`.

1. **Create the production KV namespace** (one-shot):

   ```bash
   wrangler kv namespace create RATE_LIMIT_KV
   ```

   Wrangler prints something like `id = "abcdef..."`. Paste it into
   `workers/rate-limit/wrangler.toml` under `[[kv_namespaces]]` `id`.

2. **Set production env vars** (Cloudflare-side):

   ```bash
   wrangler secret put SUPABASE_PROJECT_URL          # https://{ref}.supabase.co
   wrangler secret put SUPABASE_SERVICE_ROLE_KEY     # static service-role JWT from supabase status
   wrangler secret put RATE_LIMIT_PER_MINUTE         # default 100; adjust per pilot
   ```

   `SUPABASE_PROJECT_URL` MUST match the linked Supabase project; mismatched
   means the worker proxies to the wrong upstream and authenticated calls
   fail at Supabase.

   `SUPABASE_SERVICE_ROLE_KEY` MUST be the static service-role JWT printed
   by `supabase status` (or copied from the Supabase dashboard). If unset,
   no caller bypasses the rate limit (every call from sms-worker,
   dispute-notify, operator scripts is counted under their JWT.sub or, if
   unauthenticated, falls into the anonymous bypass which is fine for the
   first MVP path). Story 6.2 (sms-worker) is the first MVP code path that
   needs this set.

3. **Deploy**:

   ```bash
   npm run worker:rate-limit:deploy
   ```

   Wrangler prints the deployed URL, e.g.
   `https://safaricash-rate-limit.{cf-account}.workers.dev`.

4. **Wire the frontend**: in Cloudflare Pages production env, set:

   ```
   VITE_SUPABASE_FUNCTIONS_GATEWAY_URL=https://safaricash-rate-limit.{cf-account}.workers.dev
   ```

   Trigger a Pages re-deploy so the env bakes into the bundle. Without
   this, the React PWA bypasses the Worker and calls Supabase directly —
   the FR49 rate limit is non-functional.

5. **Smoke-test the prod gate**:

   ```bash
   # 101 sequential POSTs from a known collector JWT against the worker URL.
   WORKER_BASE_URL=https://safaricash-rate-limit.{cf-account}.workers.dev \
     npx playwright test tests/e2e/rate-limit.spec.ts
   ```

   The 101st response must be 429 + `Retry-After`. If it's 200 or 500,
   the worker is misconfigured — re-check env + KV namespace.

## Adjusting the rate limit (NFR-S9 "based on pilot observation")

```bash
wrangler secret put RATE_LIMIT_PER_MINUTE
# Enter new value (e.g. 200), press Enter.
# Worker picks up the new value on next request — no redeploy required.
```

## Rollback / kill-switch

If the worker starts producing false-positive 429s in production (e.g.,
threshold mis-set, collector legitimately needs >100/min for a one-off
import), there are three escalation paths from cheapest to most disruptive:

1. **Disable the rate limit without redeploy** (preferred):

   ```bash
   wrangler secret put RATE_LIMIT_PER_MINUTE
   # Enter: 0
   # Worker now proxies every collector request without consulting KV.
   ```

   `RATE_LIMIT_PER_MINUTE=0` is an operator-recognised value meaning
   "rate-limit disabled" — the worker still proxies but skips the KV
   round-trip entirely. Restore by setting back to 100 (or any positive
   integer).

2. **Bypass the worker at the frontend**: in Cloudflare Pages env, unset
   `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` (delete the variable entirely)
   and trigger a Pages redeploy. The PWA then calls Supabase directly —
   no rate limit at this layer; Supabase Pro's native limits still apply.
   Slower than option 1 (~5 min Pages deploy) but an option if the worker
   itself is throwing 5xx.

3. **Roll back the worker deployment**:

   ```bash
   wrangler rollback --config workers/rate-limit/wrangler.toml
   # Lists previous deployments; pick the last-known-good and confirm.
   ```

   Use only if the current code has a runtime bug that options 1 + 2
   don't address.

## Tail logs (operational)

```bash
npm run worker:rate-limit:tail
```

You'll see structured JSON like:

```json
{
  "level": "warn",
  "event": "ratelimit.exceeded",
  "ts": "2026-04-20T10:23:45.123Z",
  "collector_id": "abc...",
  "bucket_minute": "2026-04-20T10:23",
  "count": 101,
  "threshold": 100,
  "retry_after_s": 15
}
```

A high frequency of `ratelimit.exceeded` for a single `collector_id` is a
**credential-compromise signal** — see `_bmad-output/implementation-artifacts/deferred-work.md`
for the founder-alert plumbing follow-up.

## Trade-offs (documented architectural choices, honest version)

| Choice                                            | Why                                                                                                            | Real cost / when to revisit                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers KV (eventual consistency)                 | Free tier (with the cap below); zero infra to provision.                                                       | Sub-second bursts across CF POPs may exceed 100/min briefly. Bucket-boundary attack lets one collector send 200 req in <2s straddling a minute. Migrate to Durable Objects when the MVP outgrows the free-tier write cap (also $5/mo Workers Paid plan; same trigger condition as below). |
| KV write quota = **1,000 writes/day** (free tier) | At 100 req/active-period × N collectors, free tier supports **≤10 active collectors/day**.                     | **HARD CAP** for MVP. When the 11th collector needs to onboard, switch to Workers Paid plan ($5/mo, 1M writes/day) AND consider Durable Objects in the same migration (fixes consistency too).                                                                                            |
| Trust-and-decode JWT for `sub` (collector_id)     | Avoids fetching JWKS or storing the JWT secret in Worker env per request.                                      | An attacker who knows another collector's UUID (visible in audit_log payloads + their own JWT) can forge a JWT with that `sub` and burn the victim's 100/min, locking the legitimate collector out. Targeted DoS, not data exposure. Revisit if exploited in the wild.                    |
| Service-role bypass via raw bearer compare        | The service-role JWT is a static project-scoped value (not per-request); compare in constant time against env. | Operator MUST treat `SUPABASE_SERVICE_ROLE_KEY` as a real secret (set via `wrangler secret put`, never `[vars]`). Leakage = unlimited bypass.                                                                                                                                             |
| Fail-open on internal error                       | Closed-fail = single-point-of-failure for the entire app.                                                      | Fail-open is **silent** today — only `wrangler tail` surfaces it. Cloudflare Health Check + automated alerting on `ratelimit.middleware_error` is deferred to Story 1.8 (CI + observability gates).                                                                                       |
| Anonymous bypass                                  | Supabase Pro's native limits handle unauthenticated traffic.                                                   | When SafariCash adds a public surface beyond the receipt-URL worker (separate worker, NOT this one), reassess.                                                                                                                                                                            |

## Files

- `wrangler.toml` — Worker config (KV binding, env vars, observability).
- `tsconfig.json` — strict TS for the Worker runtime (`@cloudflare/workers-types`).
- `scripts/check-config.mjs` — pre-deploy lint (rejects placeholder values).
- `src/index.ts` — handler entry point (CORS → method allowlist → bypass-or-count → 429-or-proxy → fail-open).
- `src/bearer.ts` — constant-time service-role bearer compare (Story 1.4 review fix B1).
- `src/jwt.ts` — trust-and-decode JWT helper (collector_id only; NEVER trusted for bypass).
- `src/counter.ts` — KV sliding-window-by-minute counter.
- `src/proxy.ts` — transparent proxy to Supabase (10s timeout → 504 RFC 7807).
- `src/rfc7807.ts` — 429 Problem Details builder (mirrors Story 1.3's shape).
- `src/index.test.ts` — Vitest unit tests (18 scenarios incl. forged-service-role regression guard).

## Related

- Story spec: `_bmad-output/implementation-artifacts/1-4-rate-limit-middleware.md`.
- Story 1.3 production-deploy gate (closed by this worker's deploy):
  `_bmad-output/implementation-artifacts/deferred-work.md` § first entry.
- Architecture commitment: `_bmad-output/planning-artifacts/architecture.md` § Authentication & Security line 349.
