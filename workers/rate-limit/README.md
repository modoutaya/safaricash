# `workers/rate-limit/` — SafariCash rate-limit middleware

Cloudflare Worker that fronts Supabase Edge Functions and enforces NFR-S9
(100 req/min/collector). Story 1.4 implementation.

## What it does

```
React PWA  →→→  this Worker  →→→  Supabase Edge Functions
                    │
                    ├── decode JWT.sub → collector_id
                    ├── KV: increment rl:{collector_id}:{minute}
                    ├── if count > 100 → 429 RFC 7807 + Retry-After
                    ├── if anonymous OR service_role → bypass
                    ├── if KV down OR internal error → fail-OPEN (proxy)
                    └── else → proxy to Supabase
```

- **Anonymous (no JWT)** → bypass; Supabase Pro's native limits handle it.
- **`service_role` JWT** → bypass; sms-worker / dispute-notify Edge
  Functions need unbounded throughput.
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

1. **Create the production KV namespace** (one-shot):

   ```bash
   wrangler kv namespace create RATE_LIMIT_KV
   ```

   Wrangler prints something like `id = "abcdef..."`. Paste it into
   `workers/rate-limit/wrangler.toml` under `[[kv_namespaces]]` `id`.

2. **Set production env vars** (Cloudflare-side):

   ```bash
   wrangler secret put SUPABASE_PROJECT_URL    # https://{ref}.supabase.co
   wrangler secret put RATE_LIMIT_PER_MINUTE   # default 100; adjust per pilot
   ```

   `SUPABASE_PROJECT_URL` MUST match the linked Supabase project; mismatched
   means the worker proxies to the wrong upstream and authenticated calls
   fail at Supabase.

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
  "bucket_key": "rl:abc...:2026-04-20T10:23",
  "count": 101,
  "threshold": 100,
  "retry_after_s": 15
}
```

A high frequency of `ratelimit.exceeded` for a single `collector_id` is a
**credential-compromise signal** — see `_bmad-output/implementation-artifacts/deferred-work.md`
for the founder-alert plumbing follow-up.

## Trade-offs (documented architectural choices)

| Choice                                     | Why                                                                                                                                      | When to revisit                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Workers KV (eventual consistency)          | Free tier; simple. Sub-second bursts across CF POPs may exceed 100/min briefly.                                                          | Migrate to Durable Objects if pilot data shows the burst-bypass is exploited (requires Workers Paid $5/mo). |
| Trust-and-decode JWT (no signature verify) | Avoids duplicating the JWT secret into Worker env or fetching JWKS on every request. Forged JWTs only burn quota for fake collector_ids. | If JWT-forgery-as-DoS becomes a real signal, add JWKS verification.                                         |
| Fail-open on internal error                | Closed-fail = single-point-of-failure for the entire app. Open-fail loses rate-limit briefly but app stays up.                           | Add Cloudflare Health Check + alerting in Story 1.8.                                                        |
| Service-role bypass                        | sms-worker + dispute-notify need unbounded throughput; no MVP super_admin role.                                                          | When Story 6.2 (sms-worker) lands, add a smoke test asserting bypass.                                       |

## Files

- `wrangler.toml` — Worker config (KV binding, env vars, observability).
- `tsconfig.json` — strict TS for the Worker runtime (`@cloudflare/workers-types`).
- `src/index.ts` — handler entry point (decode → bypass-or-count → 429-or-proxy → fail-open).
- `src/jwt.ts` — trust-and-decode JWT helper.
- `src/counter.ts` — KV sliding-window-by-minute counter.
- `src/proxy.ts` — transparent proxy to Supabase.
- `src/rfc7807.ts` — 429 Problem Details builder (mirrors Story 1.3's shape).
- `src/index.test.ts` — Vitest unit tests (10 scenarios, KV mocked).

## Related

- Story spec: `_bmad-output/implementation-artifacts/1-4-rate-limit-middleware.md`.
- Story 1.3 production-deploy gate (closed by this worker's deploy):
  `_bmad-output/implementation-artifacts/deferred-work.md` § first entry.
- Architecture commitment: `_bmad-output/planning-artifacts/architecture.md` § Authentication & Security line 349.
