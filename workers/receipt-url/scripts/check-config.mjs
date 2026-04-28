#!/usr/bin/env node
// Pre-deploy lint for workers/receipt-url/wrangler.toml.
//
// Rejects shipping the example.supabase.co SUPABASE_PROJECT_URL placeholder
// — would proxy real production receipt-token lookups to a foreign
// Supabase project. Wired into npm run worker:receipt-url:deploy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tomlPath = resolve(__dirname, "..", "wrangler.toml");
const toml = readFileSync(tomlPath, "utf8");

const errors = [];

// SUPABASE_PROJECT_URL placeholder check.
const urlMatch = toml.match(/SUPABASE_PROJECT_URL\s*=\s*"([^"]+)"/);
if (urlMatch && /example\.supabase\.co/i.test(urlMatch[1])) {
  errors.push(
    "wrangler.toml [vars] SUPABASE_PROJECT_URL is the example placeholder. " +
      "Set the real project URL (https://{ref}.supabase.co) — either edit " +
      "wrangler.toml or run `wrangler secret put SUPABASE_PROJECT_URL`.",
  );
}

// Required-keys sanity.
for (const key of ["name", "main", "compatibility_date"]) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m");
  const m = toml.match(re);
  if (!m || !m[1]) {
    errors.push(`wrangler.toml is missing required top-level key '${key}'.`);
  }
}

if (errors.length > 0) {
  if (process.env.SKIP_RECEIPT_URL_CONFIG_CHECK === "1") {
    console.warn("\n[receipt-url:check-config] WARN — placeholder(s) detected but bypass set:\n");
    for (const e of errors) console.warn("  - " + e);
    console.warn("Continuing because SKIP_RECEIPT_URL_CONFIG_CHECK=1.\n");
    process.exit(0);
  }
  console.error("\n[receipt-url:check-config] FAIL — refusing to deploy:\n");
  for (const e of errors) console.error("  - " + e);
  console.error(
    "\nIf you really mean to deploy with these values (you don't), bypass with " +
      "`SKIP_RECEIPT_URL_CONFIG_CHECK=1 npm run worker:receipt-url:deploy`.\n",
  );
  process.exit(1);
}

console.log("[receipt-url:check-config] OK — wrangler.toml has no placeholder values.");
