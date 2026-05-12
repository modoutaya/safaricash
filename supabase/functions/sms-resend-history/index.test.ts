// Story 6.6 — sms-resend-history Edge Function contract tests.
//
// Runs against LIVE cloud Supabase via supabase-cli linked project.
// Same env / fixture pattern as re-auth/index.test.ts (Story 1.5b).
//
// Covers:
//   1. Method GET → 405.
//   2. Anonymous (no JWT) → 401 auth_unauthenticated.
//   3. Wrong password → 401 credentials_invalid.
//   4. Body missing cycle_id → 400 request_invalid.
//   5. Body invalid uuid for member_id → 400 request_invalid.
//   6. Foreign member (not owned by caller) → 404 not_found.
//   7. Happy path → 200 { enqueued: 2, reason: null } + service-role-side
//      check that resend rows exist + one sms.resend_initiated audit event.
//   8. Opt-out saver → 200 { enqueued: 0, reason: "opt_out" }; no resend rows.

import { assertEquals } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { handler } from "./index.ts";
import { cleanup, seedCollector, seedMemberWithCycle } from "../_shared/test-fixtures.ts";

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const env = envOrSkip();

Deno.test({
  name: "sms-resend-history (6.6) — skip when env not set",
  ignore: !!env,
  fn: () => {
    console.log("Skip — Supabase env not set.");
  },
});

function buildReq(jwt: string | null, body: unknown, method = "POST"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("https://safaricash-test.local/functions/v1/sms-resend-history", {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

async function recordContrib(
  userClient: ReturnType<typeof createClient>,
  memberId: string,
  cycleId: string,
  cycleDay: number,
): Promise<string> {
  const { data: txId, error } = await userClient.rpc("record_contribution", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
    p_amount: 500,
    p_cycle_day: cycleDay,
  });
  if (error || !txId) throw new Error(`record_contribution: ${error?.message}`);
  return txId as string;
}

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "1. Method GET → 405",
    ...denoOpts,
    fn: async () => {
      const res = await handler(buildReq(null, {}, "GET"));
      assertEquals(res.status, 405);
    },
  });

  Deno.test({
    name: "2. Anonymous (no JWT) → 401 auth_unauthenticated",
    ...denoOpts,
    fn: async () => {
      const res = await handler(
        buildReq(null, {
          member_id: crypto.randomUUID(),
          cycle_id: crypto.randomUUID(),
          password: "irrelevant",
        }),
      );
      assertEquals(res.status, 401);
      const body = await res.json();
      // Code-review patch (P5): exact URN-suffix match instead of a
      // substring `includes` that would coincidentally pass on any future
      // URN containing the same fragment.
      assertEquals(body.type?.endsWith("/auth/unauthenticated"), true);
    },
  });

  Deno.test({
    name: "3. Wrong password → 401 credentials_invalid",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rh3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const res = await handler(
          buildReq(c.jwt, {
            member_id: memberId,
            cycle_id: cycleId,
            password: "wrong-password",
          }),
        );
        assertEquals(res.status, 401);
        const body = await res.json();
        assertEquals(body.type?.endsWith("/credentials/invalid"), true);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "4. Body missing cycle_id → 400 request_invalid",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rh4");
      try {
        const res = await handler(
          buildReq(c.jwt, {
            member_id: crypto.randomUUID(),
            password: c.password,
          }),
        );
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.type?.endsWith("/request/invalid"), true);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "5. Body invalid uuid for member_id → 400 request_invalid",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rh5");
      try {
        const res = await handler(
          buildReq(c.jwt, {
            member_id: "not-a-uuid",
            cycle_id: crypto.randomUUID(),
            password: c.password,
          }),
        );
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.type?.endsWith("/request/invalid"), true);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "6. Foreign member (not owned) → 404 not_found",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const owner = await seedCollector(service, anon, "rh6a");
      const intruder = await seedCollector(service, anon, "rh6b");
      try {
        const ownerClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${owner.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(ownerClient, service, owner.userId);

        const res = await handler(
          buildReq(intruder.jwt, {
            member_id: memberId,
            cycle_id: cycleId,
            password: intruder.password,
          }),
        );
        assertEquals(res.status, 404);
        const body = await res.json();
        assertEquals(body.type?.endsWith("/request/not_found"), true);
      } finally {
        await cleanup(service, owner);
        await cleanup(service, intruder);
      }
    },
  });

  Deno.test({
    name: "7. Happy path → 200 { enqueued: 2, reason: null } + 2 resend rows + 1 audit event",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rh7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await recordContrib(userClient, memberId, cycleId, 1);
        await recordContrib(userClient, memberId, cycleId, 2);

        const res = await handler(
          buildReq(c.jwt, {
            member_id: memberId,
            cycle_id: cycleId,
            password: c.password,
          }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.enqueued, 2);
        assertEquals(body.reason, null);

        // Service-role check: 2 sms_queue rows with template_key='resend'.
        const { data: rows } = await service
          .from("sms_queue")
          .select("body, template_key")
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");
        assertEquals(rows?.length, 2);

        // One audit event.
        const { count: auditCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("event_type", "sms.resend_initiated");
        assertEquals(auditCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "8. Opt-out saver → 200 { enqueued: 0, reason: 'opt_out' }; no rows",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rh8");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await recordContrib(userClient, memberId, cycleId, 1);

        // Flip opt-out flag.
        await service.from("members").update({ sms_opt_out: true }).eq("id", memberId);

        const res = await handler(
          buildReq(c.jwt, {
            member_id: memberId,
            cycle_id: cycleId,
            password: c.password,
          }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.enqueued, 0);
        assertEquals(body.reason, "opt_out");

        const { count } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");
        assertEquals(count, 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
