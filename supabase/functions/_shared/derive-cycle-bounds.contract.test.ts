// Story 11.3 — contract test cross-checking the SQL public.derive_cycle_bounds
// against the TypeScript deriveCycleBounds (src/domain/cycle/cycleEngine.ts).
// The two are the canonical reference and its SQL mirror (ADR-004 Decision #1
// + § Amendment A1 / INV-9). This test is the guardrail that catches drift.
//
// Skips when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset (same pattern
// as the other _shared contract tests). Runs via `npm run test:edge`.

import { assertEquals } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { deriveCycleBounds } from "../../../src/domain/cycle/cycleEngine.ts";

function envOrSkip(): { url: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

// Representative dates exercising every branch of INV-9:
//   1. Full 30-day month, registered on the 1st (length = month length, cap inert).
//   2. Worked example — 7th of a 30-day month → length 24.
//   3. rawLen = MIN_CYCLE_LENGTH_DAYS exactly (no roll-forward — the
//      "≥ boundary inclusive" case from ADR A1.4).
//   4. rawLen = 2 < MIN → roll-forward.
//   5. rawLen = 1 < MIN → roll-forward.
//   6. Dec → Jan year-boundary roll-forward.
//   7. Leap-year February (2028) starting on the 1st (length 29).
//   8. Leap-year February — exactly MIN remaining (no roll).
//   9. Leap-year February — rawLen 2 < MIN → roll to March.
//  10. Non-leap February (2026, 28 days).
//
//  Story 11.5 § A1.8 — cap-rule cases (31-day months where cap shifts output):
//  11. 31-day May, registered on the 1st → end = day 30 (was day 31).
//  12. 31-day May, registered on the 25th (operator threshold worked example).
//  13. 31-day May, registered on day 28 = post-cap MIN boundary (no roll).
//  14. 31-day May, registered on day 29 = post-cap rolls (was: stayed).
//  15. 31-day December, registered on day 29 = post-cap rolls + year boundary.
const REPRESENTATIVE_DATES: ReadonlyArray<string> = [
  "2026-04-01",
  "2026-04-07",
  "2026-04-28",
  "2026-04-29",
  "2026-04-30",
  "2026-12-30",
  "2028-02-01",
  "2028-02-27",
  "2028-02-28",
  "2026-02-01",
  "2026-05-01",
  "2026-05-25",
  "2026-05-28",
  "2026-05-29",
  "2026-12-29",
];

const env = envOrSkip();

Deno.test({
  name: "derive_cycle_bounds (11.3) — skip when Supabase env not set",
  ignore: !!env,
  fn: () => {
    console.log("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping SQL↔TS cross-check.");
  },
});

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  Deno.test({
    name: "SQL derive_cycle_bounds matches TS deriveCycleBounds for every representative date",
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      for (const today of REPRESENTATIVE_DATES) {
        const ts = deriveCycleBounds(today);
        // supabase.rpc must be called inline, never extracted into a free
        // variable (memory project_supabase_rpc_binding — preserves
        // this.rest access).
        const { data, error } = await service.rpc("derive_cycle_bounds", {
          p_today: today,
        });
        assertEquals(error, null, `RPC error for ${today}: ${error?.message ?? ""}`);
        const sql = (data as Array<{ start_date: string; end_date: string }> | null)?.[0];
        assertEquals(
          sql,
          { start_date: ts.startDate, end_date: ts.endDate },
          `SQL/TS mismatch for ${today}`,
        );
      }
    },
  });
}
