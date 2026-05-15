// Story 8.6 — Idempotency contract test for update_member.
//
// Validates the Story 8.6 p_event_id idempotent early-return on
// update_member (the reconciler replays offline member edits through it):
//   1. Fresh p_event_id → row updated, members.last_event_id set, exactly
//      one member.updated audit row.
//   2. Same p_event_id replayed (with DIFFERENT values) → early-return,
//      no second UPDATE (values unchanged), still one audit row.
//   3. p_event_id = NULL (the online edit path) → updates normally, a
//      member.updated audit row emitted.
//
// Shares the seeding boilerplate shape of record-rpcs-idempotent.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

type Collector = { userId: string; phone: string; password: string; jwt: string };

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
): Promise<Collector> {
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

async function seedMember(userClient: SupabaseClient): Promise<string> {
  const { data: memberId, error } = await userClient.rpc("create_member_with_cycle", {
    p_name: "Update Member Test",
    p_phone_number: "+221770000222",
    p_daily_amount: 500,
  });
  if (error || !memberId) throw new Error(`seedMember: ${error?.message}`);
  return memberId as string;
}

async function cleanup(service: SupabaseClient, c: Collector): Promise<void> {
  await service.from("transactions").delete().eq("collector_id", c.userId);
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}

function userClientFor(env: { url: string; anonKey: string }, jwt: string): SupabaseClient {
  return createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

async function memberUpdatedAuditCount(service: SupabaseClient, memberId: string): Promise<number> {
  const { count } = await service
    .from("audit_log")
    .select("event_id", { count: "exact", head: true })
    .eq("entity_id", memberId)
    .eq("event_type", "member.updated");
  return count ?? -1;
}

const env = envOrSkip();

Deno.test({
  name: "Story 8.6 update_member idempotency — skip when Supabase env not set",
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
  const anon = createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "update_member — fresh p_event_id updates the row + sets last_event_id + one audit row",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "upd1");
      try {
        const user = userClientFor(env, c.jwt);
        const memberId = await seedMember(user);
        const eventId = crypto.randomUUID();

        const { error } = await user.rpc("update_member", {
          p_id: memberId,
          p_name: "Renamed Member",
          p_phone_number: "+221770000222",
          p_daily_amount: 600,
          p_event_id: eventId,
        });
        assertEquals(error, null);

        const { data: row } = await service
          .from("members")
          .select("daily_amount, last_event_id")
          .eq("id", memberId)
          .single();
        assertEquals(row?.daily_amount, 600);
        assertEquals(row?.last_event_id, eventId);

        const auditCount = await memberUpdatedAuditCount(service, memberId);
        assert(auditCount >= 0, "audit_log must be readable by the service role");
        assertEquals(auditCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "update_member — same p_event_id replayed is a no-op (no second UPDATE, no second audit)",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "upd2");
      try {
        const user = userClientFor(env, c.jwt);
        const memberId = await seedMember(user);
        const eventId = crypto.randomUUID();

        const { error: firstErr } = await user.rpc("update_member", {
          p_id: memberId,
          p_name: "First Apply",
          p_phone_number: "+221770000222",
          p_daily_amount: 600,
          p_event_id: eventId,
        });
        assertEquals(firstErr, null);

        // Replay the SAME event id but with DIFFERENT values — the
        // idempotent early-return must keep the first-apply values.
        const { error: replayErr } = await user.rpc("update_member", {
          p_id: memberId,
          p_name: "Should Be Ignored",
          p_phone_number: "+221770000222",
          p_daily_amount: 999,
          p_event_id: eventId,
        });
        assertEquals(replayErr, null);

        const { data: row } = await service
          .from("members")
          .select("daily_amount")
          .eq("id", memberId)
          .single();
        // 600 (first apply) — NOT 999 (the replay was a no-op).
        assertEquals(row?.daily_amount, 600);

        assertEquals(await memberUpdatedAuditCount(service, memberId), 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "update_member — p_event_id NULL (online path) updates normally + emits an audit row",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "upd3");
      try {
        const user = userClientFor(env, c.jwt);
        const memberId = await seedMember(user);

        const { error } = await user.rpc("update_member", {
          p_id: memberId,
          p_name: "Online Edit",
          p_phone_number: "+221770000222",
          p_daily_amount: 750,
        });
        assertEquals(error, null);

        const { data: row } = await service
          .from("members")
          .select("daily_amount, last_event_id")
          .eq("id", memberId)
          .single();
        assertEquals(row?.daily_amount, 750);
        assertEquals(row?.last_event_id, null);
        assertEquals(await memberUpdatedAuditCount(service, memberId), 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
