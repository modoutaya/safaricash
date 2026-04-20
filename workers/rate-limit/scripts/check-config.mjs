#!/usr/bin/env node
// Pre-deploy lint for workers/rate-limit/wrangler.toml.
//
// Rejects shipping the placeholder KV namespace id or the example.supabase.co
// SUPABASE_PROJECT_URL — both would cause the deployed worker to either
// fail (KV id) or proxy real production traffic to example.supabase.co
// (leaking JWTs + request bodies). Wired into npm run worker:rate-limit:deploy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tomlPath = resolve(__dirname, "..", "wrangler.toml");
const toml = readFileSync(tomlPath, "utf8");

const errors = [];

// 1. KV namespace `id` placeholder ("000...0" of any length ≥ 32 chars).
const idMatch = toml.match(/^\s*id\s*=\s*"(0+)"/m);
if (idMatch && idMatch[1].length >= 32) {
  errors.push(
    "wrangler.toml [[kv_namespaces]] id is the all-zero placeholder. Run " +
      "`wrangler kv namespace create RATE_LIMIT_KV` and paste the resulting id.",
  );
}

// 2. SUPABASE_PROJECT_URL placeholder.
const urlMatch = toml.match(/SUPABASE_PROJECT_URL\s*=\s*"([^"]+)"/);
if (urlMatch && /example\.supabase\.co/i.test(urlMatch[1])) {
  errors.push(
    "wrangler.toml [vars] SUPABASE_PROJECT_URL is the example placeholder. " +
      "Set the real project URL (https://{ref}.supabase.co) — either edit " +
      "wrangler.toml or run `wrangler secret put SUPABASE_PROJECT_URL`.",
  );
}

if (errors.length > 0) {
  if (process.env.SKIP_RATE_LIMIT_CONFIG_CHECK === "1") {
    console.warn("\n[rate-limit:check-config] WARN — placeholder(s) detected but bypass set:\n");
    for (const e of errors) console.warn("  - " + e);
    console.warn("Continuing because SKIP_RATE_LIMIT_CONFIG_CHECK=1.\n");
    process.exit(0);
  }
  console.error("\n[rate-limit:check-config] FAIL — refusing to deploy:\n");
  for (const e of errors) console.error("  - " + e);
  console.error(
    "\nIf you really mean to deploy with these values (you don't), bypass with " +
      "`SKIP_RATE_LIMIT_CONFIG_CHECK=1 npm run worker:rate-limit:deploy`.\n",
  );
  process.exit(1);
}

console.log("[rate-limit:check-config] OK — wrangler.toml has no placeholder values.");
