// Shared test fixtures for Edge Function contract / integration tests.
//
// Extracted in Story 6.2 (sms-worker) — the two prior consumers (Story 6.1
// `sms-dispatch/index.test.ts` and `sms-dispatch-trigger.contract.test.ts`)
// each had their own copies of `seedCollector` + `seedMemberWithCycle` +
// `cleanup`. Centralising here so a third consumer (sms-worker) reuses
// the same fixtures and future stories don't keep cloning the helpers.
//
// Test files import from this module via:
//   import { seedCollector, seedMemberWithCycle, cleanup } from "../_shared/test-fixtures.ts";

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type PhoneCollector = {
  userId: string;
  phone: string;
  password: string;
  jwt: string;
};

/** Seeds a phone-authenticated collector with both auth.users + public.users rows. */
export async function seedCollector(
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

/** Seeds a member + auto-creates the bootstrap cycle via create_member_with_cycle RPC.
 *
 *  Story 11.3 note — `create_member_with_cycle` now produces a calendar-
 *  month-aligned variable-length cycle (length depends on today's date).
 *  To keep the >20 contract tests asserting legacy `× 29` math stable
 *  across calendar dates, this helper pins the seeded cycle's
 *  start_date/end_date to a fixed 30-day window after creation
 *  (via service-role UPDATE). Tests that need a partial-cycle (Story 11.3
 *  new path) call `seedMemberWithCycleBounds` instead. */
export async function seedMemberWithCycle(
  userClient: SupabaseClient,
  service: SupabaseClient,
  collectorId: string,
  phoneNumber: string = "+221770000666",
): Promise<{ memberId: string; cycleId: string }> {
  const { data: memberId, error: createErr } = await userClient.rpc("create_member_with_cycle", {
    p_name: "Test Member",
    p_phone_number: phoneNumber,
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
  // Story 11.3 — pin to a deterministic 30-day window so existing tests
  // (`× 29` math) stay valid regardless of when they run. Mirrors the
  // pre-11.3 cycle shape (start + 29 days).
  const { error: pinErr } = await service
    .from("cycles")
    .update({ start_date: "2026-04-01", end_date: "2026-04-30" })
    .eq("id", cycle.id);
  if (pinErr) throw new Error(`seedMember: pin cycle dates — ${pinErr.message}`);
  return { memberId, cycleId: cycle.id };
}

/** Story 11.3 — seeds a member + creates a cycle with caller-specified bounds.
 *  Used by the new variable-length tests that need a partial / month-aligned
 *  cycle (e.g. cycleLength = 24, the worked example). Defaults to the same
 *  pinned 30-day window as `seedMemberWithCycle` for explicitness. */
export async function seedMemberWithCycleBounds(
  userClient: SupabaseClient,
  service: SupabaseClient,
  collectorId: string,
  options: {
    startDate?: string;
    endDate?: string;
    phoneNumber?: string;
    dailyAmount?: number;
  } = {},
): Promise<{ memberId: string; cycleId: string; startDate: string; endDate: string }> {
  const startDate = options.startDate ?? "2026-04-01";
  const endDate = options.endDate ?? "2026-04-30";
  const phoneNumber = options.phoneNumber ?? "+221770000777";
  const dailyAmount = options.dailyAmount ?? 500;
  const { data: memberId, error: createErr } = await userClient.rpc("create_member_with_cycle", {
    p_name: "Test Member",
    p_phone_number: phoneNumber,
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
  const { error: pinErr } = await service
    .from("cycles")
    .update({ start_date: startDate, end_date: endDate })
    .eq("id", cycle.id);
  if (pinErr) throw new Error(`seedMember: pin cycle dates — ${pinErr.message}`);
  return { memberId, cycleId: cycle.id, startDate, endDate };
}

/**
 * Tears down a collector's state in FK-safe order.
 *
 * Every table below references public.users(id) ON DELETE RESTRICT, so the
 * public.users row — and in turn the auth.users row (public.users → auth
 * is itself RESTRICT) — can only be removed once they are all cleared.
 * Order matters: disputes reference transactions; members/cycles/
 * transactions deletes fire the AFTER-DELETE audit trigger, so audit_log
 * is purged last (after those rows AND their delete-audit rows exist).
 *
 * Previously this only deleted sms_queue/transactions/cycles/members and
 * then called deleteUser — which silently failed against the RESTRICT FK,
 * leaking an orphan public.users + auth.users row on every test run.
 */
export async function cleanup(service: SupabaseClient, c: PhoneCollector): Promise<void> {
  await service.from("sms_queue").delete().eq("collector_id", c.userId);
  await service.from("disputes").delete().eq("collector_id", c.userId);
  await service.from("transactions").delete().eq("collector_id", c.userId);
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.from("audit_log").delete().eq("collector_id", c.userId);
  await service.from("users").delete().eq("id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}
