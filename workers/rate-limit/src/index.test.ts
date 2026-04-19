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

function buildRequest(opts: { method?: string; authJwt?: string | null; path?: string }): Request {
  const headers: HeadersInit = {};
  if (opts.authJwt !== null && opts.authJwt !== undefined) {
    headers["Authorization"] = `Bearer ${opts.authJwt}`;
  }
  return new Request(
    `https://safaricash-api.example.workers.dev${opts.path ?? "/functions/v1/re-auth"}`,
    {
      method: opts.method ?? "POST",
      headers,
      body:
        opts.method === "GET" || opts.method === "HEAD"
          ? null
          : JSON.stringify({ action: "issue" }),
    },
  );
}

const ctx = {} as ExecutionContext;

const baseEnv = (kv: KVNamespace, threshold = "100"): Env => ({
  RATE_LIMIT_KV: kv,
  SUPABASE_PROJECT_URL: "https://example.supabase.co",
  RATE_LIMIT_PER_MINUTE: threshold,
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

  it("(b) service-role JWT → bypasses rate-limit (proxied without count)", async () => {
    const kv = makeKv();
    const jwt = buildJwt({ sub: "service-internal", role: "service_role" });
    // Fire 200 requests; all should proxy, none should be 429.
    const responses = await Promise.all(
      Array.from({ length: 200 }, () =>
        handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx),
      ),
    );
    for (const r of responses) expect(r.status).toBe(200);
    expect((await kv.list()).keys).toHaveLength(0);
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

  it("(d) collector JWT, 101st call within same minute → 429 + Retry-After", async () => {
    const kv = makeKv();
    const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
    for (let i = 0; i < 100; i++) {
      await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
    }
    const res101 = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
    expect(res101.status).toBe(429);
    expect(res101.headers.get("Content-Type")).toBe("application/problem+json");
    expect(res101.headers.get("Retry-After")).toMatch(/^\d+$/);
    const body = (await res101.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("https://safaricash.app/problems/ratelimit/exceeded");
    expect(typeof body["retry_after_seconds"]).toBe("number");
  });

  it("(e) collector JWT, 101st call AFTER 60s rollover → proxies (new bucket)", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-04-20T10:23:30.000Z");
      vi.setSystemTime(start);

      const kv = makeKv();
      const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
      // Fill the 10:23 bucket.
      for (let i = 0; i < 100; i++) {
        await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      }
      const blocked = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      expect(blocked.status).toBe(429);

      // Advance to the next minute → bucket key changes → counter resets.
      vi.setSystemTime(new Date("2026-04-20T10:24:05.000Z"));
      const allowedAgain = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      expect(allowedAgain.status).toBe(200);
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

  it("(g) malformed JWT → treated as anonymous (proxy through)", async () => {
    const kv = makeKv();
    const res = await handler.fetch(buildRequest({ authJwt: "not.a.jwt" }), baseEnv(kv), ctx);
    expect(res.status).toBe(200);
    expect((await kv.list()).keys).toHaveLength(0);
  });

  it("(h) internal KV error → fail-open (proxy through), error logged", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const kv = makeFailingKv();
      const jwt = buildJwt({ sub: "collector-A", role: "authenticated" });
      const res = await handler.fetch(buildRequest({ authJwt: jwt }), baseEnv(kv), ctx);
      // Failed-open = proxy succeeded with 200.
      expect(res.status).toBe(200);
      // The error was logged.
      const calls = consoleSpy.mock.calls.flat().filter((arg) => typeof arg === "string");
      const middlewareErrorLogged = calls.some((s) =>
        (s as string).includes("ratelimit.middleware_error"),
      );
      expect(middlewareErrorLogged).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
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
    } finally {
      consoleSpy.mockRestore();
    }
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
