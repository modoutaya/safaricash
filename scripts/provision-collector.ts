#!/usr/bin/env node
// Story 1.5b — Provision a new collector (PRD v1.3 auth pivot).
//
// Invoke: npm run provision-collector -- --phone +221771234567 \
//                                        --password '<defaultPassword>' \
//                                        --name 'Mamadou Ndiaye'
//
// What it does:
//   1. `supabase.auth.admin.createUser` with phone_confirm: true so the
//      collector can sign in immediately.
//   2. Insert the matching public.users row (role = 'collector', name).
//   3. Print the credentials for the founder to forward via WhatsApp / call.
//
// --name is optional but recommended: public.users.name drives the
// dashboard's "Bonjour {prénom}" greeting. Omitted → NULL → the greeting
// falls back to the generic "Bonjour Collecteur".
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
const name = values.name?.trim() ? values.name.trim() : null;
if (!phone || !password) {
  console.error(
    "Usage: npm run provision-collector -- --phone +221771234567 --password '<p>' [--name '<nom>']",
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
  role: "collector",
  name,
});
if (insertErr) {
  // Roll back the auth user so the two sides stay aligned. If the
  // rollback itself fails (network blip, rate-limit, race), surface
  // the orphan loudly — otherwise a silent orphan locks the phone
  // out of future re-provisioning (createUser rejects duplicates).
  const { error: rollbackErr } = await admin.auth.admin.deleteUser(userId);
  if (rollbackErr) {
    console.error(
      `public.users insert failed: ${insertErr.message}\n` +
        `⚠️  ROLLBACK ALSO FAILED: ${rollbackErr.message}\n` +
        `MANUAL CLEANUP REQUIRED — delete auth user ${userId} via Supabase Studio:\n` +
        `  Dashboard → Authentication → Users → find ${phone} → Delete\n` +
        `Otherwise re-provisioning ${phone} will fail with "User already registered".`,
    );
    process.exit(2);
  }
  console.error(`public.users insert failed: ${insertErr.message}. Auth user rolled back.`);
  process.exit(1);
}

console.log("\n✅ Collector provisioned. Forward these credentials out-of-band:\n");
console.log(`   Phone:    ${phone}`);
console.log(`   Password: ${password}`);
console.log(`   Name:     ${name ?? "(none — dashboard greets 'Bonjour Collecteur')"}`);
console.log(`   User ID:  ${userId}\n`);
console.log("They sign in at /login with the phone + password.");
