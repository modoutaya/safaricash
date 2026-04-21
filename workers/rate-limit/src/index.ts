// SafariCash Story 1.4 — rate-limit middleware Worker entry point.
//
// Request lifecycle:
//   1. OPTIONS (CORS preflight) → short-circuit 204 with CORS headers.
//   2. Method allowlist (defense-in-depth).
//   3. Bearer-token check: matches SUPABASE_SERVICE_ROLE_KEY exactly?
//      → bypass (used by sms-worker, dispute-notify, operator scripts).
//      Compared in constant time; never trust JWT.role claim (forgeable).
//   4. Decode Authorization header → { collectorId, role } or null.
//   5. No JWT (anonymous) → proxy to Supabase, no count.
//   6. Authenticated collector JWT → KV increment + check.
//      - If count > threshold → 429 RFC 7807 + Retry-After + structured log.
//      - Else proxy to Supabase.
//   7. Any internal error (KV down, decode crash, fetch crash) → FAIL OPEN
//      (proxy to Supabase). Closed-fail = single-point-of-failure for the
//      entire app. Documented trade-off in story spec § Anti-patterns.
//
// Logs are structured JSON to stdout — queryable via `wrangler tail`.

import { isLegitimateServiceRole } from "./bearer";
import { incrementAndCheck } from "./counter";
import { decodeJwt } from "./jwt";
import { proxyToSupabase } from "./proxy";
import { rateLimitedResponse } from "./rfc7807";

export interface Env {
  RATE_LIMIT_KV: KVNamespace;
  SUPABASE_PROJECT_URL: string;
  RATE_LIMIT_PER_MINUTE: string;
  // Static Supabase service-role JWT — set via `wrangler secret put`.
  // Compared in constant time to bypass rate-limiting for backend-to-backend
  // callers (sms-worker, dispute-notify, operator scripts). Empty/unset
  // means NO bypass — all callers go through the per-collector counter.
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

type LogLevel = "info" | "warn" | "error";
type LogEvent = "ratelimit.exceeded" | "ratelimit.middleware_error" | "ratelimit.config_missing";

const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"]);

// Mirrors Supabase Edge Functions' default CORS surface; keep in sync if
// Supabase adds/removes default-allowed headers.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS,HEAD",
  "Access-Control-Allow-Headers":
    "authorization,content-type,apikey,x-client-info,prefer,accept,accept-profile,content-profile",
  "Access-Control-Max-Age": "86400",
};

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
  if (raw === undefined || raw === "") return 100;
  const n = Number.parseInt(raw, 10);
  // Accept 0 explicitly — operator opt-out (disable rate limiting entirely).
  // Reject negative or non-finite — fall back to safe default.
  if (!Number.isFinite(n) || n < 0) return 100;
  return n;
}

/** Strip the URL down to pathname only — query strings may carry tokens. */
function safeInstance(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return "/";
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // ---------------------------------------------------------------------
    // 0. Story 1.8 — unauthenticated /health endpoint. Used by CI's
    //    wrangler-dev readiness probe (before the rate-limit spec runs).
    //    MUST come before any env check / auth / KV — the probe runs in
    //    the first ~500ms of wrangler boot, and a rate-limit miss or env
    //    misread on /health would make CI flaky.
    // ---------------------------------------------------------------------
    if (new URL(request.url).pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // ---------------------------------------------------------------------
    // 1. CORS preflight short-circuit. Frontend (*.pages.dev) → worker
    //    (*.workers.dev) is cross-origin; browser sends OPTIONS first.
    //    Don't consult KV — preflight is idempotent + safe.
    // ---------------------------------------------------------------------
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ---------------------------------------------------------------------
    // 2. Method allowlist (defense-in-depth — TRACE / CONNECT / etc.)
    // ---------------------------------------------------------------------
    if (!ALLOWED_METHODS.has(request.method)) {
      return new Response(
        JSON.stringify({
          type: "https://safaricash.app/problems/method/not-allowed",
          title: "Method not allowed",
          status: 405,
          detail: `Method ${request.method} is not supported by this proxy.`,
        }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/problem+json",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            ...CORS_HEADERS,
          },
        },
      );
    }

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
          headers: {
            "Content-Type": "application/problem+json",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const threshold = parseThreshold(env.RATE_LIMIT_PER_MINUTE);

    // ---------------------------------------------------------------------
    // 3. Service-role bypass via constant-time bearer-token compare.
    //    NEVER use jwt.role — forgeable.
    // ---------------------------------------------------------------------
    const authHeader = request.headers.get("Authorization");
    if (isLegitimateServiceRole(authHeader, env.SUPABASE_SERVICE_ROLE_KEY)) {
      try {
        return await proxyToSupabase(request, env.SUPABASE_PROJECT_URL);
      } catch (err) {
        logJson("error", "ratelimit.middleware_error", {
          phase: "proxy_service_role",
          error: (err as Error).message,
        });
        throw err;
      }
    }

    // ---------------------------------------------------------------------
    // 4. Decode collector JWT (no signature verify — trust-and-decode).
    // ---------------------------------------------------------------------
    let jwt: ReturnType<typeof decodeJwt>;
    try {
      jwt = decodeJwt(authHeader);
    } catch (err) {
      // Defensive — decodeJwt should never throw, but if it does, treat as
      // anonymous (do not block).
      logJson("error", "ratelimit.middleware_error", {
        phase: "jwt_decode",
        error: (err as Error).message,
      });
      jwt = null;
    }

    // ---------------------------------------------------------------------
    // 5. Anonymous (no usable JWT) → bypass; Supabase Pro's native limits
    //    handle unauthenticated traffic.
    // ---------------------------------------------------------------------
    if (!jwt) {
      try {
        return await proxyToSupabase(request, env.SUPABASE_PROJECT_URL);
      } catch (err) {
        logJson("error", "ratelimit.middleware_error", {
          phase: "proxy_anonymous",
          error: (err as Error).message,
        });
        throw err;
      }
    }

    // ---------------------------------------------------------------------
    // 6. threshold === 0 means "rate-limit disabled" (operator opt-out).
    //    Skip the KV round-trip entirely.
    // ---------------------------------------------------------------------
    if (threshold === 0) {
      return proxyToSupabase(request, env.SUPABASE_PROJECT_URL);
    }

    // ---------------------------------------------------------------------
    // 7. Authenticated collector — KV-backed counter.
    // ---------------------------------------------------------------------
    let result: Awaited<ReturnType<typeof incrementAndCheck>>;
    try {
      result = await incrementAndCheck(env.RATE_LIMIT_KV, jwt.collectorId, threshold, new Date());
    } catch (err) {
      // KV failure must FAIL OPEN. Log loudly so ops sees the degradation.
      // Alerting is deferred to Story 1.8 (CI + observability gates).
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
        bucket_minute: result.bucketMinute,
        count: result.count,
        threshold,
        retry_after_s: result.bucketSecondsRemaining,
      });
      return rateLimitedResponse(result.bucketSecondsRemaining, safeInstance(request.url));
    }

    return proxyToSupabase(request, env.SUPABASE_PROJECT_URL);
  },
};
