#!/usr/bin/env node
// Story 1.5b — Provision a new collector (PRD v1.3 auth pivot).
//
// Invoke: npm run provision-collector -- --phone +221771234567 \
//                                        --password '<defaultPassword>' \
//                                        --name 'Ibrahim Sow'
//
// What it does:
//   1. `supabase.auth.admin.createUser` with phone_confirm: true so the
//      collector can sign in immediately.
//   2. Insert the matching public.users row (role = 'collector').
//   3. Print the credentials for the founder to forward via WhatsApp / call.
//
// Env (in .env.local):
//   VITE_SUPABASE_URL         — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — bypasses RLS; NEVER commit
//
// See README.md § Operator runbook — collector provisioning.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

// --- env loader (minimal — avoids adding dotenv as a dep).
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
    name: { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const phone = values.phone;
const password = values.password;
const name = values.name;
if (!phone || !password || !name) {
  console.error(
    "Usage: npm run provision-collector -- --phone +221771234567 --password '<p>' --name 'Ibrahim Sow'",
  );
  process.exit(1);
}
if (!/^\+221[0-9]{9}$/.test(phone)) {
  console.error(`Phone must be E.164 Senegal (+221XXXXXXXXX), got: ${phone}`);
  process.exit(1);
}
if (password.length < 6) {
  console.error("Password must be ≥ 6 characters (Supabase Auth server floor).");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const created = await admin.auth.admin.createUser({
  phone,
  password,
  phone_confirm: true,
});
if (created.error || !created.data.user) {
  console.error(`createUser failed: ${created.error?.message ?? "unknown"}`);
  process.exit(1);
}

const userId = created.data.user.id;
const { error: insertErr } = await admin.from("users").insert({
  id: userId,
  phone_number: phone,
  full_name: name,
  role: "collector",
});
if (insertErr) {
  // Roll back the auth user so the two sides stay aligned.
  await admin.auth.admin.deleteUser(userId);
  console.error(`public.users insert failed: ${insertErr.message}. Auth user rolled back.`);
  process.exit(1);
}

console.log("\n✅ Collector provisioned. Forward these credentials out-of-band:\n");
console.log(`   Phone:    ${phone}`);
console.log(`   Password: ${password}`);
console.log(`   Name:     ${name}`);
console.log(`   User ID:  ${userId}\n`);
console.log("They sign in at /login with the phone + password.");
