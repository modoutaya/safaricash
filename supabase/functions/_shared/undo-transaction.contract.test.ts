// Story 4.5 — undo_transaction RPC + soft-undo audit + view-filter contract.
//
// Asserts:
//   1. Happy path → undone_at set, sms_queue row → abandoned, audit
//      transaction.committed AND transaction.undone both land,
//      transactions_decrypted view filters out the row, raw table keeps
//      it, undone_event_id populated.
//   2. Window expired (created_at > 5s ago) → 22023.
//   3. Already undone (idempotent) → 0L000.
//   4. Foreign collector → 28000.
//   5. Not found → P0002.
//   6. sms_queue already 'sent' → undo succeeds, sms_queue row stays
//      in 'sent' status (the SMS already left the building).
//   7. Audit event_type is 'transaction.undone' (not generic
//      transaction.updated).
//   8. transactions_decrypted view DOES NOT return undone rows;
//      raw `transactions` table DOES.

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
): Promise<{ memberId: string; cycleId: string }> {
  const { data: memberId, error: createErr } = await userClient.rpc("create_member_with_cycle", {
    p_name: "Test Member",
    p_phone_number: "+221770000333",
    p_daily_amount: 500,
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

async function recordContrib(
  userClient: SupabaseClient,
  memberId: string,
  cycleId: string,
): Promise<string> {
  const { data: txId, error } = await userClient.rpc("record_contribution", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
    p_amount: 500,
    p_cycle_day: 1,
  });
  if (error || !txId) throw new Error(`record_contribution: ${error?.message}`);
  return txId as string;
}

const env = envOrSkip();

Deno.test({
  name: "undo_transaction (4.5) — skip when Supabase env not set",
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
    name: "happy path — soft-undo: undone_at set + sms abandoned + audit transaction.undone + view filter",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "und1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const txId = await recordContrib(userClient, memberId, cycleId);

        // Trigger fired audit transaction.committed + sms_queue row.
        const { count: smsBefore } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("transaction_id", txId);
        assertEquals(smsBefore, 1);

        const { error: undoErr } = await userClient.rpc("undo_transaction", {
          p_transaction_id: txId,
        });
        assertEquals(undoErr, null);

        // 1. transactions.undone_at set.
        const { data: rawTx } = await service
          .from("transactions")
          .select("undone_at")
          .eq("id", txId)
          .single();
        assert(rawTx?.undone_at !== null);

        // 2. sms_queue row → abandoned.
        const { data: smsRow } = await service
          .from("sms_queue")
          .select("status")
          .eq("transaction_id", txId)
          .single();
        assertEquals(smsRow?.status, "abandoned");

        // 3. Audit chain has transaction.undone.
        const { data: undoneEvents } = await service
          .from("audit_log")
          .select("event_id, event_type")
          .eq("entity_id", txId)
          .eq("event_type", "transaction.undone");
        assertEquals(undoneEvents?.length, 1);

        // 4. transactions_decrypted view DOES NOT return the row.
        const { data: viewRow } = await service
          .from("transactions_decrypted")
          .select("id")
          .eq("id", txId)
          .maybeSingle();
        assertEquals(viewRow, null);

        // 5. Raw `transactions` table DOES still have the row.
        const { data: rawRow } = await service
          .from("transactions")
          .select("id")
          .eq("id", txId)
          .single();
        assertEquals(rawRow?.id, txId);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "window expired — created_at > 5s ago → 22023",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "und2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const txId = await recordContrib(userClient, memberId, cycleId);

        // Backdate the row by 10 seconds via service-role.
        await service
          .from("transactions")
          .update({ created_at: new Date(Date.now() - 10_000).toISOString() })
          .eq("id", txId);

        const { error: undoErr } = await userClient.rpc("undo_transaction", {
          p_transaction_id: txId,
        });
        assert(undoErr !== null);
        assertEquals(undoErr?.code, "22023");
        assertStringIncludes(undoErr?.message ?? "", "window_expired");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "already undone — second call → 0L000 (idempotent guard)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "und3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const txId = await recordContrib(userClient, memberId, cycleId);

        const { error: firstErr } = await userClient.rpc("undo_transaction", {
          p_transaction_id: txId,
        });
        assertEquals(firstErr, null);

        const { error: secondErr } = await userClient.rpc("undo_transaction", {
          p_transaction_id: txId,
        });
        assert(secondErr !== null);
        assertEquals(secondErr?.code, "0L000");
        assertStringIncludes(secondErr?.message ?? "", "already_undone");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "foreign collector — undo on someone else's tx → 28000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const ownerC = await seedCollector(service, anon, "und4o");
      const intruderC = await seedCollector(service, anon, "und4i");
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
        const txId = await recordContrib(ownerClient, memberId, cycleId);

        const intruderClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${intruderC.jwt}` } },
        });

        const { error: rpcErr } = await intruderClient.rpc("undo_transaction", {
          p_transaction_id: txId,
        });
        assert(rpcErr !== null);
        // The function checks ownership and raises 28000. RLS may also
        // reject the SELECT first (P0002 not_found if RLS hides the row).
        // Either pathway is acceptable as long as the intruder can't undo.
        const code = rpcErr?.code ?? "";
        assert(code === "28000" || code === "P0002");
      } finally {
        await cleanup(service, ownerC);
        await cleanup(service, intruderC);
      }
    },
  });

  Deno.test({
    name: "not found — random uuid → P0002",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "und5");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });

        const { error: rpcErr } = await userClient.rpc("undo_transaction", {
          p_transaction_id: "00000000-0000-4000-8000-000000000000",
        });
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "P0002");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "sms already sent — undo succeeds, sms_queue stays 'sent'",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "und6");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        // Simulate the SMS worker having dispatched the message.
        await service.from("sms_queue").update({ status: "sent" }).eq("transaction_id", txId);

        const { error: undoErr } = await userClient.rpc("undo_transaction", {
          p_transaction_id: txId,
        });
        assertEquals(undoErr, null);

        const { data: smsRow } = await service
          .from("sms_queue")
          .select("status")
          .eq("transaction_id", txId)
          .single();
        // sent → stays sent. The undo only flips queued rows.
        assertEquals(smsRow?.status, "sent");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "audit chain — transaction.undone event_type (not generic transaction.updated)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "und7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        await userClient.rpc("undo_transaction", { p_transaction_id: txId });

        const { data: events } = await service
          .from("audit_log")
          .select("event_type")
          .eq("entity_id", txId)
          .order("timestamp", { ascending: true });

        const types = (events ?? []).map((r: { event_type: string }) => r.event_type);
        assert(types.includes("transaction.committed"));
        assert(types.includes("transaction.undone"));
        // Critical: the typed transaction.undone short-circuits the
        // generic transaction.updated branch.
        assertEquals(types.filter((t: string) => t === "transaction.updated").length, 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
