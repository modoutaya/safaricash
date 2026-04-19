// SafariCash Story 1.4 — rate-limit middleware Worker entry point.
//
// Request lifecycle:
//   1. Decode Authorization header → { collectorId, role } or null.
//   2. Anonymous (no JWT) OR service-role JWT → proxy to Supabase, no count.
//   3. Authenticated collector JWT → KV increment + check.
//      - If count > threshold → 429 RFC 7807 + Retry-After + structured log.
//      - Else proxy to Supabase.
//   4. Any internal error (KV down, decode crash, fetch crash) → FAIL OPEN
//      (proxy to Supabase). Closed-fail = single-point-of-failure for the
//      entire app. Documented trade-off in story spec § Anti-patterns.
//
// Logs are structured JSON to stdout — queryable via `wrangler tail`.

import { incrementAndCheck } from "./counter";
import { decodeJwt, isServiceRole } from "./jwt";
import { proxyToSupabase } from "./proxy";
import { rateLimitedResponse } from "./rfc7807";

export interface Env {
  RATE_LIMIT_KV: KVNamespace;
  SUPABASE_PROJECT_URL: string;
  RATE_LIMIT_PER_MINUTE: string;
}

type LogLevel = "info" | "warn" | "error";
type LogEvent = "ratelimit.exceeded" | "ratelimit.middleware_error" | "ratelimit.config_missing";

function logJson(level: LogLevel, event: LogEvent, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      level,
      event,
      ts: new Date().toISOString(),
      ...fields,
    }),
  );
}

function parseThreshold(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "100", 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Hard-required env: SUPABASE_PROJECT_URL. Without it we cannot proxy.
    if (!env.SUPABASE_PROJECT_URL) {
      logJson("error", "ratelimit.config_missing", {
        missing: "SUPABASE_PROJECT_URL",
      });
      return new Response(
        JSON.stringify({
          type: "https://safaricash.app/problems/internal/unexpected",
          title: "Worker misconfigured",
          status: 500,
          detail: "SUPABASE_PROJECT_URL not set in worker env",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/problem+json" },
        },
      );
    }

    const threshold = parseThreshold(env.RATE_LIMIT_PER_MINUTE);

    let jwt: ReturnType<typeof decodeJwt>;
    try {
      jwt = decodeJwt(request.headers.get("Authorization"));
    } catch (err) {
      // Defensive — decodeJwt should never throw, but if it does, treat as
      // anonymous (do not block).
      logJson("error", "ratelimit.middleware_error", {
        phase: "jwt_decode",
        error: (err as Error).message,
      });
      jwt = null;
    }

    // Anonymous or service-role → bypass.
    if (!jwt || isServiceRole(jwt)) {
      try {
        return await proxyToSupabase(request, env.SUPABASE_PROJECT_URL);
      } catch (err) {
        logJson("error", "ratelimit.middleware_error", {
          phase: "proxy_bypass",
          error: (err as Error).message,
        });
        // Re-throw → Cloudflare returns 500. The proxy itself failed; the
        // worker can't recover.
        throw err;
      }
    }

    // Authenticated collector — KV-backed counter.
    let result: Awaited<ReturnType<typeof incrementAndCheck>>;
    try {
      result = await incrementAndCheck(env.RATE_LIMIT_KV, jwt.collectorId, threshold, new Date());
    } catch (err) {
      // CODE REVIEW pre-mitigation (story anti-pattern): KV failure must
      // FAIL OPEN. Log loudly so ops sees the degradation.
      logJson("error", "ratelimit.middleware_error", {
        phase: "kv_increment",
        collector_id: jwt.collectorId,
        error: (err as Error).message,
      });
      try {
        return await proxyToSupabase(request, env.SUPABASE_PROJECT_URL);
      } catch (proxyErr) {
        logJson("error", "ratelimit.middleware_error", {
          phase: "proxy_after_kv_fail",
          error: (proxyErr as Error).message,
        });
        throw proxyErr;
      }
    }

    if (!result.allowed) {
      logJson("warn", "ratelimit.exceeded", {
        collector_id: jwt.collectorId,
        bucket_key: result.bucketKey,
        count: result.count,
        threshold,
        retry_after_s: result.bucketSecondsRemaining,
      });
      return rateLimitedResponse(result.bucketSecondsRemaining, request.url);
    }

    return proxyToSupabase(request, env.SUPABASE_PROJECT_URL);
  },
};
