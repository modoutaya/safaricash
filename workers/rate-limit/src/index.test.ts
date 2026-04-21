// Story 1.4 — rate-limit Worker tests.
//
// Hand-rolled KV namespace mock + fetch stub keep these tests runtime-
// agnostic. They run via the project root Vitest config (we add
// `workers/**/*.test.ts` to the include list). No real Cloudflare account
// or wrangler dev needed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler, { type Env } from "./index";

// ---------------------------------------------------------------------------
// In-memory KV mock (matches the subset of KVNamespace we use).
// ---------------------------------------------------------------------------

function makeKv(): KVNamespace {
  const store = new Map<string, { value: string; expires: number }>();
  return {
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expires > 0 && Date.now() > entry.expires) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      const ttlMs = (opts?.expirationTtl ?? 0) * 1000;
      store.set(key, {
        value,
        expires: ttlMs > 0 ? Date.now() + ttlMs : 0,
      });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })) };
    },
  } as unknown as KVNamespace;
}

function makeFailingKv(): KVNamespace {
  return {
    async get() {
      throw new Error("kv simulated failure");
    },
    async put() {
      throw new Error("kv simulated failure");
    },
    async delete() {
      throw new Error("kv simulated failure");
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Test JWT helpers (trust-and-decode shortcut means we just have to assemble
// valid base64 payloads — signatures don't matter to the worker).
// ---------------------------------------------------------------------------

function buildJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = btoa(JSON.stringify(payload))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.fake-signature`;
}

function buildRequest(opts: {
  method?: string;
  authJwt?: string | null;
  authBearer?: string | null;
  path?: string;
}): Request {
  const headers: HeadersInit = {};
  if (opts.authBearer !== undefined && opts.authBearer !== null) {
    headers["Authorization"] = `Bearer ${opts.authBearer}`;
  } else if (opts.authJwt !== null && opts.authJwt !== undefined) {
    headers["Authorization"] = `Bearer ${opts.authJwt}`;
  }
  return new Request(
    `https://safaricash-api.example.workers.dev${opts.path ?? "/functions/v1/re-auth"}`,
    {
      method: opts.method ?? "POST",
      headers,
      body:
        opts.method === "GET" || opts.method === "HEAD" || opts.method === "OPTIONS"
          ? null
          : JSON.stringify({ action: "issue" }),
    },
  );
}

const ctx = {} as ExecutionContext;

// Realistic-shape service-role key (length matters for constant-time compare).
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvY2FsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9." +
  "the-real-static-service-role-signature-bytes";

const baseEnv = (kv: KVNamespace, threshold = "100"): Env => ({
  RATE_LIMIT_KV: kv,
  SUPABASE_PROJECT_URL: "https://example.supabase.co",
  RATE_LIMIT_PER_MINUTE: threshold,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
});

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Stub global fetch so the worker's proxy doesn't actually hit Supabase.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ proxied: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rate-limit worker", () => {
  it("(a) anonymous request → proxies without rate-limiting", async () => {
    const kv = makeKv();
    const res = await handler.fetch(buildRequest({ authJwt: null }), baseEnv(kv), ctx);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await kv.list()).keys).toHaveLength(0); // no counter key written
  });

  it("(b) legitimate service-role bearer (env match) → bypasses rate-limit", async () => {
    const kv = makeKv();
    // Fire 200 requests with the real service-role key; all proxy, no count.
    const responses = await Promise.all(
      Array.from({ length: 200 }, () =>
        handler.fetch(buildRequest({ authBearer: SERVICE_ROLE_KEY }), baseEnv(kv), ctx),
      ),
    );
    for (const r of responses) expect(r.status).toBe(200);
    expect((await kv.list()).keys).toHaveLength(0);
  });

  it("(b2) FORGED service-role JWT (role claim only, signature wrong) → counted as collector", async () => {
    // CRITICAL regression guard for review finding F1.
    // Anyone could craft a JWT with {role: "service_role"} in the payload —
    // before the fix, the worker trusted the unverified role claim.
    const kv = makeKv();
    const forgedJwt = buildJwt({ sub: "attacker-A", role: "service_role" });
    for (let i = 0; i < 100; i++) {
      const res = await handler.fetch(buildRequest({ authBearer: forgedJwt }), baseEnv(kv), ctx);
      expect(res.status, `request #${i + 1} should proxy`).toBe(200);
    }
    const r101 = await handler.fetch(buildRequest({ authBearer: forgedJwt }), baseEnv(kv), ctx);
    expect(r101.status, "101st forged service-role request must be 429, not bypass").toBe(429);
  });

  it("(b3) service-role bearer with no SUPABASE_SERVICE_ROLE_KEY env → no bypass", async () => {
    const kv = makeKv();
    const env: Env = {
      RATE_LIMIT_KV: kv,
      SUPABASE_PROJECT_URL: "https://example.supabase.co",
      RATE_LIMIT_PER_MINUTE: "100",
      // SUPABASE_SERVICE_ROLE_KEY intentionally undefined.
    };
    // Legitimate-looking JWT body — handler must still rate-limit because
    // the bypass check has no expected key to compare against.
    const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
    for (let i = 0; i < 100; i++) {
      await handler.fetch(buildRequest({ authBearer: jwt }), env, ctx);
    }
    const r101 = await handler.fetch(buildRequest({ authBearer: jwt }), env, ctx);
    expect(r101.status).toBe(429);
  });

  it("(c) collector JWT, first 100 calls → all proxy", async () => {
    const kv = makeKv();
    const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
    for (let i = 0; i < 100; i++) {
      const res = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      expect(res.status, `request #${i + 1} should proxy`).toBe(200);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(100);
  });

  it("(d) collector JWT, 101st call within same minute → 429 + Retry-After + security headers", async () => {
    const kv = makeKv();
    const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
    for (let i = 0; i < 100; i++) {
      await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
    }
    const res101 = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
    expect(res101.status).toBe(429);
    expect(res101.headers.get("Content-Type")).toBe("application/problem+json");
    expect(res101.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(res101.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res101.headers.get("Cache-Control")).toBe("no-store");
    expect(res101.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res101.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("https://safaricash.app/problems/ratelimit/exceeded");
    expect(typeof body["retry_after_seconds"]).toBe("number");
    // instance MUST be pathname only (no query string — leak guard).
    expect(body["instance"]).toBe("/functions/v1/re-auth");
  });

  it("(d2) 429 instance strips query string (token-leak guard)", async () => {
    const kv = makeKv();
    const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
    const path = "/functions/v1/re-auth?token=secret-do-not-echo";
    for (let i = 0; i < 100; i++) {
      await handler.fetch(buildRequest({ authJwt: jwt, path }), baseEnv(kv), ctx);
    }
    const r = await handler.fetch(buildRequest({ authJwt: jwt, path }), baseEnv(kv), ctx);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["instance"]).toBe("/functions/v1/re-auth");
    expect(JSON.stringify(body)).not.toContain("secret-do-not-echo");
  });

  it("(e) collector JWT, 101st call AFTER 60s rollover → proxies (new bucket)", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-04-20T10:23:30.000Z");
      vi.setSystemTime(start);

      const kv = makeKv();
      const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
      for (let i = 0; i < 100; i++) {
        await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      }
      const blocked = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      expect(blocked.status).toBe(429);

      vi.setSystemTime(new Date("2026-04-20T10:24:05.000Z"));
      const allowedAgain = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      expect(allowedAgain.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(e2) bucket boundary attack — 100 requests in last second + 100 in first second of next bucket BOTH succeed (documented behavior)", async () => {
    // This test EXISTS to lock in the documented MVP trade-off (story spec
    // AC #4(b)). If we ever migrate to Durable Objects (strong consistency)
    // the expected behavior changes — this test must then be updated.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-20T10:23:59.500Z"));
      const kv = makeKv();
      const jwt = buildJwt({ sub: "collector-boundary", role: "authenticated" });

      for (let i = 0; i < 100; i++) {
        const r = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
        expect(r.status, `last-second req #${i + 1}`).toBe(200);
      }
      vi.setSystemTime(new Date("2026-04-20T10:24:00.500Z"));
      for (let i = 0; i < 100; i++) {
        const r = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
        expect(r.status, `first-second req #${i + 1}`).toBe(200);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("(f) RATE_LIMIT_PER_MINUTE=10 env override → 429 on 11th", async () => {
    const kv = makeKv();
    const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
    for (let i = 0; i < 10; i++) {
      const res = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv, "10"), ctx);
      expect(res.status).toBe(200);
    }
    const r11 = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv, "10"), ctx);
    expect(r11.status).toBe(429);
  });

  it("(f2) RATE_LIMIT_PER_MINUTE=0 → rate-limit DISABLED (operator kill-switch)", async () => {
    const kv = makeKv();
    const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
    for (let i = 0; i < 250; i++) {
      const res = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv, "0"), ctx);
      expect(res.status, `req #${i + 1}`).toBe(200);
    }
    expect((await kv.list()).keys).toHaveLength(0); // zero-threshold skips KV entirely
  });

  it("(g) malformed JWT → treated as anonymous (proxy through)", async () => {
    const kv = makeKv();
    const res = await handler.fetch(buildRequest({ authJwt: "not.a.jwt" }), baseEnv(kv), ctx);
    expect(res.status).toBe(200);
    expect((await kv.list()).keys).toHaveLength(0);
  });

  it("(g2) oversized JWT payload (>8KB) → treated as anonymous (no OOM)", async () => {
    const kv = makeKv();
    // Payload of ~10KB should be rejected by decodeJwt size cap.
    const big = "A".repeat(10_000);
    const res = await handler.fetch(buildRequest({ authJwt: big }), baseEnv(kv), ctx);
    expect(res.status).toBe(200);
    expect((await kv.list()).keys).toHaveLength(0);
  });

  it("(h) internal KV error → fail-open (proxy through), error logged", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const kv = makeFailingKv();
      const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
      const res = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      expect(res.status).toBe(200);
      const calls = consoleSpy.mock.calls.flat().filter((arg) => typeof arg === "string");
      const middlewareErrorLogged = calls.some((s) =>
        (s as string).includes("ratelimit.middleware_error"),
      );
      expect(middlewareErrorLogged).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("(i) OPTIONS preflight → 204 + CORS headers, no KV consult", async () => {
    const kv = makeKv();
    const res = await handler.fetch(
      buildRequest({ method: "OPTIONS", authJwt: null }),
      baseEnv(kv),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
    expect(fetchSpy).not.toHaveBeenCalled(); // never proxies
    expect((await kv.list()).keys).toHaveLength(0);
  });

  it("(j) disallowed method (custom verb) → 405 + RFC 7807", async () => {
    // Node's Request constructor blocks TRACE/CONNECT/TRACK at the platform
    // level, so we mock a Request-shaped object directly to exercise the
    // worker's allowlist (which is itself defense-in-depth — production CF
    // runtime may also block these).
    const kv = makeKv();
    const fakeReq = {
      method: "PURGE",
      headers: new Headers(),
      url: "https://safaricash-api.example.workers.dev/functions/v1/re-auth",
      body: null,
    } as unknown as Request;
    const res = await handler.fetch(fakeReq, baseEnv(kv), ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
  });

  it("logs ratelimit.exceeded with collector_id + count + threshold on 429", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const kv = makeKv();
      const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
      for (let i = 0; i < 100; i++) {
        await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      }
      consoleSpy.mockClear();
      await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      const lines = consoleSpy.mock.calls.flat().map((arg) => String(arg));
      const exceeded = lines.find((s) => s.includes("ratelimit.exceeded"));
      expect(exceeded).toBeDefined();
      const parsed = JSON.parse(exceeded!) as Record<string, unknown>;
      expect(parsed["collector_id"]).toBe("collector-A");
      expect(parsed["count"]).toBe(101);
      expect(parsed["threshold"]).toBe(100);
      // bucket_minute (not bucket_key) — collector_id no longer duplicated.
      expect(typeof parsed["bucket_minute"]).toBe("string");
      expect(parsed["bucket_minute"]).not.toContain("collector-A");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("(story 1.8) GET /health → 200 { ok: true } without KV / env / auth", async () => {
    // Readiness probe for CI's `wrangler dev` startup. MUST short-circuit
    // before any of the fail-early paths (config_missing, auth, KV).
    const failingKv = makeFailingKv();
    const env: Env = {
      RATE_LIMIT_KV: failingKv,
      // Deliberately empty — /health must still respond 200.
      SUPABASE_PROJECT_URL: "",
      RATE_LIMIT_PER_MINUTE: "100",
    };
    const req = new Request("https://safaricash-api.example.workers.dev/health", {
      method: "GET",
    });
    const res = await handler.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // And no KV operation was attempted (would have thrown).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing SUPABASE_PROJECT_URL → 500 with config_missing log", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const kv = makeKv();
      const env: Env = {
        RATE_LIMIT_KV: kv,
        SUPABASE_PROJECT_URL: "",
        RATE_LIMIT_PER_MINUTE: "100",
      };
      const res = await handler.fetch(buildRequest({ authJwt: null }), env, ctx);
      expect(res.status).toBe(500);
      const lines = consoleSpy.mock.calls.flat().map((arg) => String(arg));
      const configMissing = lines.find((s) => s.includes("ratelimit.config_missing"));
      expect(configMissing).toBeDefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
