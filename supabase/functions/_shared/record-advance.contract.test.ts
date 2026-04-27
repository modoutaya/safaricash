// Story 5.4 — record_advance RPC + DB CHECK + audit/sms/cycle-status contract.
//
// Asserts:
//   1. Happy path → row inserted with kind='advance', motive trimmed,
//      saver_acknowledged=true, days_covered=1, decrypted amount,
//      audit transaction.committed lands with motive + saver_acknowledged
//      in payload, sms_queue row enqueued, cycle status flips to
//      with_advance, cycle.transitioned audit event emitted.
//   2. Motive too short → 22000.
//   3. Acknowledgment false → 22000.
//   4. Over-limit → 22023.
//   5. Closed cycle (Story 3.4 trigger) → 23514.
//   6. Foreign collector → 28000.
//   7. DB CHECK — direct INSERT kind=advance + motive=NULL → rejected.
//   8. DB CHECK — direct INSERT kind=contribution + motive='hello' → rejected.
//   9. Audit payload contains motive + saver_acknowledged.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

type PhoneCollector = {
  userId: string;
  phone: string;
  password: string;
  jwt: string;
};

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

async function seedCollector(
  service: SupabaseClient,
  anon: SupabaseClient,
  label: string,
): Promise<PhoneCollector> {
  const stamp = Date.now();
  const bytes = new Uint8Array(7);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes)
    .map((b) => (b % 10).toString())
    .join("");
  const phone = `+22177${suffix}`;
  const password = `Pw-${label}-${suffix}-${stamp}`;

  const { data, error } = await service.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
  });
  if (error || !data.user) throw new Error(`seed(${label}): ${error?.message}`);
  const userId = data.user.id;

  const { error: usersErr } = await service
    .from("users")
    .insert({ id: userId, phone_number: phone, role: "collector" });
  if (usersErr) {
    await service.auth.admin.deleteUser(userId);
    throw new Error(`seed(${label}): users insert — ${usersErr.message}`);
  }

  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    phone,
    password,
  });
  if (signInErr || !signIn.session?.access_token) {
    await service.auth.admin.deleteUser(userId);
    throw new Error(`seed(${label}): signIn — ${signInErr?.message}`);
  }
  return { userId, phone, password, jwt: signIn.session.access_token };
}

async function seedMemberWithCycle(
  userClient: SupabaseClient,
  service: SupabaseClient,
  collectorId: string,
  dailyAmount = 5000,
): Promise<{ memberId: string; cycleId: string }> {
  const { data: memberId, error: createErr } = await userClient.rpc("create_member_with_cycle", {
    p_name: "Test Member",
    p_phone_number: "+221770000444",
    p_daily_amount: dailyAmount,
  });
  if (createErr || !memberId) throw new Error(`seedMember: ${createErr?.message}`);

  const { data: cycle } = await service
    .from("cycles")
    .select("id")
    .eq("member_id", memberId)
    .eq("collector_id", collectorId)
    .single();
  if (!cycle) throw new Error("seedMember: cycle not found");
  return { memberId, cycleId: cycle.id };
}

async function cleanup(service: SupabaseClient, c: PhoneCollector): Promise<void> {
  await service.from("transactions").delete().eq("collector_id", c.userId);
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}

const env = envOrSkip();

Deno.test({
  name: "record_advance (5.4) — skip when Supabase env not set",
  ignore: !!env,
  fn: () => {
    console.log(
      "SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY not set — skipping contract tests.",
    );
  },
});

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "happy path — advance inserted + audit (with motive+ack) + sms_queue + cycle status flip",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "adv1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { data: txId, error: rpcErr } = await userClient.rpc("record_advance", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 50_000,
          p_cycle_day: 10,
          p_motive: "  urgence médicale  ",
          p_saver_acknowledged: true,
        });
        assertEquals(rpcErr, null);
        assert(typeof txId === "string");

        // 1. Transaction row.
        const { data: tx } = await service
          .from("transactions")
          .select("kind, source, days_covered, motive, saver_acknowledged")
          .eq("id", txId)
          .single();
        assertEquals(tx?.kind, "advance");
        assertEquals(tx?.source, "online");
        assertEquals(tx?.days_covered, 1);
        // RPC trims the motive on the way in.
        assertEquals(tx?.motive, "urgence médicale");
        assertEquals(tx?.saver_acknowledged, true);

        // 2. Decrypted amount.
        const { data: decrypted } = await service
          .from("transactions_decrypted")
          .select("amount")
          .eq("id", txId)
          .single();
        assertEquals(Number(decrypted?.amount), 50_000);

        // 3. Audit payload contains motive + saver_acknowledged.
        const { data: auditRows } = await service
          .from("audit_log")
          .select("event_type, payload")
          .eq("entity_id", txId)
          .eq("event_type", "transaction.committed");
        assertEquals(auditRows?.length, 1);
        const payload = auditRows?.[0]?.payload as Record<string, unknown> | undefined;
        assertEquals(payload?.["motive"], "urgence médicale");
        assertEquals(payload?.["saver_acknowledged"], true);

        // 4. sms_queue row enqueued.
        const { count: smsCount } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("transaction_id", txId);
        assertEquals(smsCount, 1);

        // 5. Cycle status flipped to with_advance + cycle.transitioned event.
        const { data: cycleAfter } = await service
          .from("cycles")
          .select("status")
          .eq("id", cycleId)
          .single();
        assertEquals(cycleAfter?.status, "with_advance");

        const { count: transitionedCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("entity_id", cycleId)
          .eq("event_type", "cycle.transitioned");
        assertEquals(transitionedCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "motive too short → 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "adv2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { error: rpcErr } = await userClient.rpc("record_advance", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 50_000,
          p_cycle_day: 10,
          p_motive: "ok",
          p_saver_acknowledged: true,
        });
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "22000");
        assertStringIncludes(rpcErr?.message ?? "", "invalid_motive");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "saver_acknowledged false → 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "adv3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { error: rpcErr } = await userClient.rpc("record_advance", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 50_000,
          p_cycle_day: 10,
          p_motive: "urgence",
          p_saver_acknowledged: false,
        });
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "22000");
        assertStringIncludes(rpcErr?.message ?? "", "missing_acknowledgment");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "over-limit → 22023",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "adv4");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        // dailyAmount=5000 → capacity = 5000 × 29 = 145_000.
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { error: rpcErr } = await userClient.rpc("record_advance", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 200_000,
          p_cycle_day: 10,
          p_motive: "urgence",
          p_saver_acknowledged: true,
        });
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "22023");
        assertStringIncludes(rpcErr?.message ?? "", "over_limit");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "closed cycle — Story 3.4 trigger raises 23514",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "adv5");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await service.from("cycles").update({ status: "completed" }).eq("id", cycleId);

        const { error: rpcErr } = await userClient.rpc("record_advance", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 50_000,
          p_cycle_day: 10,
          p_motive: "urgence",
          p_saver_acknowledged: true,
        });
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "23514");
        assertStringIncludes(rpcErr?.message ?? "", "cycle_closed");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "foreign collector — 28000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const ownerC = await seedCollector(service, anon, "adv6o");
      const intruderC = await seedCollector(service, anon, "adv6i");
      try {
        const ownerClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${ownerC.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(
          ownerClient,
          service,
          ownerC.userId,
        );

        const intruderClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${intruderC.jwt}` } },
        });

        const { error: rpcErr } = await intruderClient.rpc("record_advance", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 50_000,
          p_cycle_day: 10,
          p_motive: "urgence",
          p_saver_acknowledged: true,
        });
        assert(rpcErr !== null);
        // Either 28000 (RPC) or P0002 (RLS-hidden member).
        const code = rpcErr?.code ?? "";
        assert(code === "28000" || code === "P0002");
      } finally {
        await cleanup(service, ownerC);
        await cleanup(service, intruderC);
      }
    },
  });

  Deno.test({
    name: "DB CHECK — direct INSERT kind=advance + motive=NULL rejected",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "adv7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { data: amountSecret } = await service.rpc("vault_encrypt", {
          plaintext: "10000",
        });

        const { error: insertErr } = await service.from("transactions").insert({
          collector_id: c.userId,
          member_id: memberId,
          cycle_id: cycleId,
          kind: "advance",
          amount_encrypted: amountSecret,
          cycle_day: 5,
          source: "online",
          days_covered: 1,
          // motive: NULL ← invalid for kind=advance
          // saver_acknowledged: NULL ← invalid for kind=advance
        });
        assert(insertErr !== null);
        assertEquals(insertErr?.code, "23514");
        assertStringIncludes(insertErr?.message ?? "", "transactions_advance_motive_ack_chk");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "DB CHECK — direct INSERT kind=contribution + motive='hello' rejected",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "adv8");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { data: amountSecret } = await service.rpc("vault_encrypt", { plaintext: "500" });

        const { error: insertErr } = await service.from("transactions").insert({
          collector_id: c.userId,
          member_id: memberId,
          cycle_id: cycleId,
          kind: "contribution",
          amount_encrypted: amountSecret,
          cycle_day: 5,
          source: "online",
          days_covered: 1,
          motive: "hello", // ← invalid: only kind=advance can have motive
          saver_acknowledged: true,
        });
        assert(insertErr !== null);
        assertEquals(insertErr?.code, "23514");
        assertStringIncludes(insertErr?.message ?? "", "transactions_advance_motive_ack_chk");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
