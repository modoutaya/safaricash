// Story 6.5 — sms-inbound Edge Function contract tests.
//
// Spawns the function via `supabase functions serve` (assumed running at
// http://127.0.0.1:54321/functions/v1/sms-inbound).
//
// Cases:
//   1. Missing ?secret query param → 401.
//   2. Wrong ?secret value → 401.
//   3. Method GET → 405.
//   4. Body missing `from` → 400.
//   5. Non-STOP message → 200 + ignored=true; member.sms_opt_out unchanged.
//   6. STOP keyword + matching member → 200 + opted_out=1; flag flipped.
//   7. "stop merci" lowercase variant → matches the prefix.
//   8. Phone matched across two collectors → both members opted out.
//   9. STOP from unknown phone → 200 + opted_out=0.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { cleanup, seedCollector, seedMemberWithCycle } from "../_shared/test-fixtures.ts";

function envOrSkip(): {
  url: string;
  anonKey: string;
  serviceKey: string;
  fnUrl: string;
  inboundSecret: string;
} | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const inboundSecret = Deno.env.get("TERMII_INBOUND_SECRET") ?? "";
  if (!url || !anonKey || !serviceKey || !inboundSecret) return null;
  return { url, anonKey, serviceKey, fnUrl: `${url}/functions/v1/sms-inbound`, inboundSecret };
}

const env = envOrSkip();

Deno.test({
  name: "sms-inbound (6.5) — skip when env / TERMII_INBOUND_SECRET not set",
  ignore: !!env,
  fn: () => {
    console.log("Skip — SUPABASE / TERMII_INBOUND_SECRET env not set.");
  },
});

async function postInboundReq(
  fnUrl: string,
  inboundSecret: string,
  body: Record<string, unknown>,
  overrides?: { secret?: string; method?: string },
): Promise<Response> {
  const url = `${fnUrl}?secret=${overrides?.secret ?? inboundSecret}`;
  const method = overrides?.method ?? "POST";
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(body);
  }
  return await fetch(url, init);
}

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };
  const postInbound = (
    body: Record<string, unknown>,
    overrides?: { secret?: string; method?: string },
  ) => postInboundReq(env.fnUrl, env.inboundSecret, body, overrides);

  Deno.test({
    name: "1. missing ?secret → 401 (Kong gates → 401 before function runs)",
    ...denoOpts,
    fn: async () => {
      const res = await fetch(env.fnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "+221770000111", text: "STOP" }),
      });
      // CI / local both: Kong rejects 401 (no JWT and no apikey header
      // either — the inbound webhook is service-role-only-by-secret).
      // The function-level 401 (auth_unauthenticated) only fires when
      // the function actually runs.
      assert(res.status === 401 || res.status === 403, `expected 401 or 403, got ${res.status}`);
      await res.body?.cancel();
    },
  });

  Deno.test({
    name: "2. wrong ?secret → 401 (function-level auth_unauthenticated)",
    ...denoOpts,
    fn: async () => {
      const res = await postInbound(
        { from: "+221770000222", text: "STOP" },
        { secret: "wrong-secret" },
      );
      assertEquals(res.status, 401);
      const body = await res.json();
      assert(typeof body.type === "string");
      assert(body.type.includes("unauthenticated"));
    },
  });

  Deno.test({
    name: "3. GET → 405 method_not_allowed",
    ...denoOpts,
    fn: async () => {
      const res = await postInbound({}, { method: "GET" });
      assertEquals(res.status, 405);
      await res.body?.cancel();
    },
  });

  Deno.test({
    name: "4. missing `from` → 400 request_invalid",
    ...denoOpts,
    fn: async () => {
      const res = await postInbound({ text: "STOP" });
      assertEquals(res.status, 400);
      await res.body?.cancel();
    },
  });

  Deno.test({
    name: "5. non-STOP message → 200 ignored, member unchanged",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "in5");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId } = await seedMemberWithCycle(
          userClient,
          service,
          c.userId,
          "+221770005555",
        );

        const res = await postInbound({ from: "+221770005555", text: "merci pour le SMS" });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.ignored, true);

        const { data: row } = await service
          .from("members")
          .select("sms_opt_out")
          .eq("id", memberId)
          .single();
        assertEquals(row?.sms_opt_out, false);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "6. STOP keyword + matching member → opt-out flipped + 1 audit",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "in6");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId } = await seedMemberWithCycle(
          userClient,
          service,
          c.userId,
          "+221770006666",
        );

        const res = await postInbound({ from: "+221770006666", text: "STOP" });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.opted_out, 1);

        const { data: row } = await service
          .from("members")
          .select("sms_opt_out, sms_opt_out_via")
          .eq("id", memberId)
          .single();
        assertEquals(row?.sms_opt_out, true);
        assertEquals(row?.sms_opt_out_via, "stop_keyword");

        const { count } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("event_type", "sms.opt_out");
        assertEquals(count, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "7. 'stop merci' (lowercase + extra) → still opts out",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "in7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId } = await seedMemberWithCycle(
          userClient,
          service,
          c.userId,
          "+221770007777",
        );

        const res = await postInbound({ from: "+221770007777", text: "stop merci" });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.opted_out, 1);

        const { data: row } = await service
          .from("members")
          .select("sms_opt_out")
          .eq("id", memberId)
          .single();
        assertEquals(row?.sms_opt_out, true);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "8. multi-collector saver → both members opted out",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c1 = await seedCollector(service, anon, "in8a");
      const c2 = await seedCollector(service, anon, "in8b");
      try {
        const userClient1 = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c1.jwt}` } },
        });
        const userClient2 = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c2.jwt}` } },
        });
        const sharedPhone = "+221770008888";
        const { memberId: m1 } = await seedMemberWithCycle(
          userClient1,
          service,
          c1.userId,
          sharedPhone,
        );
        const { memberId: m2 } = await seedMemberWithCycle(
          userClient2,
          service,
          c2.userId,
          sharedPhone,
        );

        const res = await postInbound({ from: sharedPhone, text: "STOP" });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.opted_out, 2);

        const { data: rows } = await service
          .from("members")
          .select("id, sms_opt_out")
          .in("id", [m1, m2]);
        assert(rows!.every((r) => r.sms_opt_out === true));
      } finally {
        await cleanup(service, c1);
        await cleanup(service, c2);
      }
    },
  });

  Deno.test({
    name: "9. STOP from unknown phone → opted_out=0, no error",
    ...denoOpts,
    fn: async () => {
      const res = await postInbound({ from: "+221779999999", text: "STOP" });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.opted_out, 0);
    },
  });
}
