#!/usr/bin/env node
// Story 1.5b — Reset a collector's password (PRD v1.3 R-OP1 recovery path).
//
// Invoke: npm run reset-collector-password -- --phone +221771234567 \
//                                             --password '<newDefaultPassword>'
//
// What it does:
//   1. Look up the collector by phone in public.users.
//   2. `supabase.auth.admin.updateUserById(id, { password })`.
//   3. Print the new credentials for the founder to forward out-of-band.
//
// See README.md § Operator runbook — collector provisioning.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(".env.local", "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[m[1]] = val;
    }
    return out;
  } catch {
    return {};
  }
}

const fileEnv = loadEnvLocal();
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? fileEnv.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fileEnv.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set both in .env.local and retry.",
  );
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    phone: { type: "string" },
    password: { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const phone = values.phone;
const password = values.password;
if (!phone || !password) {
  console.error(
    "Usage: npm run reset-collector-password -- --phone +221771234567 --password '<newPassword>'",
  );
  process.exit(1);
}
if (password.length < 6) {
  console.error("Password must be ≥ 6 characters (Supabase Auth server floor).");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const { data: rows, error: lookupErr } = await admin
  .from("users")
  .select("id")
  .eq("phone_number", phone)
  .eq("role", "collector")
  .limit(1);
if (lookupErr) {
  console.error(`Lookup failed: ${lookupErr.message}`);
  process.exit(1);
}
const row = rows?.[0];
if (!row) {
  console.error(`No collector with phone ${phone}. Nothing to reset.`);
  process.exit(1);
}

const { error: updateErr } = await admin.auth.admin.updateUserById(row.id, { password });
if (updateErr) {
  console.error(`updateUserById failed: ${updateErr.message}`);
  process.exit(1);
}

console.log("\n✅ Password reset. Forward these credentials out-of-band:\n");
console.log(`   Phone:    ${phone}`);
console.log(`   Password: ${password}`);
console.log(`   User ID:  ${row.id}\n`);
