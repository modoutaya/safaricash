// Story 6.2 — pg_cron 'sms-worker-drain' schedule contract tests.
//
// Asserts the pg_cron job created by migration 0038 exists, runs at 30-second
// cadence, and is active. Skips gracefully when pg_cron isn't installed
// (e.g., a local stack that wasn't bootstrapped with the extension).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const env = envOrSkip();

Deno.test({
  name: "sms-worker cron schedule (6.2) — skip when env not set",
  ignore: !!env,
  fn: () => {
    console.log("Skip — Supabase env not set.");
  },
});

type CronJobRow = { jobid: number; jobname: string; schedule: string; active: boolean };
type CronJobResult = CronJobRow | { skipped: "no_cron_extension" } | { error: string };

async function readCronJob(serviceClient: ReturnType<typeof createClient>): Promise<CronJobResult> {
  // Try the PostgREST cron.job exposure first.
  const { data, error } = await serviceClient
    .schema("cron")
    .from("job")
    .select("jobid, jobname, schedule, active")
    .eq("jobname", "sms-worker-drain")
    .maybeSingle();
  if (error) {
    if (
      error.message?.toLowerCase().includes("schema") ||
      error.message?.toLowerCase().includes("does not exist")
    ) {
      return { skipped: "no_cron_extension" };
    }
    return { error: error.message };
  }
  if (!data) return { error: "sms-worker-drain not found" };
  return data as CronJobRow;
}

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "cron.job 'sms-worker-drain' exists",
    ...denoOpts,
    fn: async () => {
      const result = await readCronJob(service);
      if ("skipped" in result) {
        console.log("Skip — pg_cron not installed in this stack.");
        return;
      }
      assert(!("error" in result), `unexpected error: ${(result as { error?: string }).error}`);
      assertEquals(result.jobname, "sms-worker-drain");
    },
  });

  Deno.test({
    name: "schedule == '*/30 * * * * *' (every 30 seconds)",
    ...denoOpts,
    fn: async () => {
      const result = await readCronJob(service);
      if ("skipped" in result) return;
      assert(!("error" in result));
      assertEquals(result.schedule, "*/30 * * * * *");
    },
  });

  Deno.test({
    name: "active == true",
    ...denoOpts,
    fn: async () => {
      const result = await readCronJob(service);
      if ("skipped" in result) return;
      assert(!("error" in result));
      assertEquals(result.active, true);
    },
  });

  Deno.test({
    name: "graceful skip pattern — readCronJob returns either row OR skipped marker (no throw)",
    ...denoOpts,
    fn: async () => {
      const result = await readCronJob(service);
      // Either skipped (no extension) OR a structured row.
      if ("skipped" in result) {
        assertEquals(result.skipped, "no_cron_extension");
      } else if ("error" in result) {
        throw new Error(`unexpected error path: ${result.error}`);
      } else {
        assert(typeof result.jobid === "number");
      }
    },
  });
}
