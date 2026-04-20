// Story 1.5 — Contract test for public.check_collector_registered RPC.
//
// Verifies:
//   (a) a registered collector phone → true
//   (b) an unregistered phone → false
//   (c) a super_admin phone → false (the RPC only qualifies role=collector)
//   (d) empty/null phone → false (no SQL injection / wildcard match)
//   (e) the RPC is callable by the anonymous client (not only service-role)
//
// Runs against the LIVE cloud Supabase (linked via supabase-cli), same
// anti-pattern as re-auth/index.test.ts. Seeds + cleans up its own data.
//
// Env required (mirrored by scripts/run-edge-tests.sh):
//   SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, SUPABASE_TEST_SERVICE_ROLE_KEY
//
// Run: deno test --allow-net --allow-env --allow-read --no-check \
//        supabase/functions/_shared/check-collector-registered.contract.test.ts

import { assertEquals } from "jsr:@std/assert@1";

import {
  buildTestAnonClient,
  buildTestServiceClient,
  cleanupCollector,
  type SeededCollector,
  seedCollector,
} from "./test-utils.ts";

const ENV_OK =
  Deno.env.get("SUPABASE_TEST_URL") &&
  Deno.env.get("SUPABASE_TEST_ANON_KEY") &&
  Deno.env.get("SUPABASE_TEST_SERVICE_ROLE_KEY");

type RpcCaller = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

async function callCheck(client: RpcCaller, phone: string | null): Promise<boolean> {
  const { data, error } = await client.rpc("check_collector_registered", { p_phone: phone });
  if (error) {
    throw new Error(`check_collector_registered RPC failed: ${JSON.stringify(error)}`);
  }
  return data as boolean;
}

Deno.test({
  name: "check_collector_registered — registered collector → true",
  ignore: !ENV_OK,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const service = buildTestServiceClient();
    const anon = buildTestAnonClient();
    let collector: SeededCollector | undefined;
    try {
      collector = await seedCollector(service, anon, "CCR-pos");
      // Call via ANON client — the login flow runs before session exists.
      const result = await callCheck(anon, collector.phone);
      assertEquals(result, true);
    } finally {
      if (collector) await cleanupCollector(service, collector);
    }
  },
});

Deno.test({
  name: "check_collector_registered — unknown phone → false",
  ignore: !ENV_OK,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const anon = buildTestAnonClient();
    const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 9);
    const unknownPhone = `+22177${rand}`;
    const result = await callCheck(anon, unknownPhone);
    assertEquals(result, false);
  },
});

Deno.test({
  name: "check_collector_registered — super_admin phone → false (role-gated)",
  ignore: !ENV_OK,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const service = buildTestServiceClient();
    const anon = buildTestAnonClient();
    let collector: SeededCollector | undefined;
    try {
      collector = await seedCollector(service, anon, "CCR-admin");
      const { error: updateErr } = await service
        .from("users")
        .update({ role: "super_admin" })
        .eq("id", collector.userId);
      if (updateErr) throw new Error(`role update failed: ${updateErr.message}`);

      const result = await callCheck(anon, collector.phone);
      assertEquals(result, false);
    } finally {
      if (collector) await cleanupCollector(service, collector);
    }
  },
});

Deno.test({
  name: "check_collector_registered — empty / null / whitespace phone → false",
  ignore: !ENV_OK,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const anon = buildTestAnonClient();
    assertEquals(await callCheck(anon, ""), false);
    assertEquals(await callCheck(anon, null), false);
    // A SQL-wildcard-shaped value must NOT match any row.
    assertEquals(await callCheck(anon, "%"), false);
  },
});
