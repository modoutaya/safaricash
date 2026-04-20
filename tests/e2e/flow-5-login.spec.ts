// Story 1.5 — Flow 5 login end-to-end test.
//
// Drives the real UI against a live Supabase instance. Because MVP cannot
// reliably read OTPs out of Supabase Auth's one_time_tokens table across all
// Supabase plans, and because we do not want Termii to actually dispatch SMS
// during CI runs, the real E2E wiring is deferred to Story 1.8 (CI gates).
//
// What this spec covers today:
//   1. The public /login page renders the welcome copy and phone input.
//   2. An unregistered phone lands on /non-registered via the RPC gate
//      (no Termii call — verified by watching for the dead-end screen).
//   3. The "Appeler SafariCash" CTA exposes a tel: link with the full
//      +221 prefix (R-OP1 / AC #4).
//
// The OTP verify path is exercised by the Vitest + Deno tests (LoginForm +
// OtpStep component tests + auth-sms-hook Deno tests). A future hook, once
// Supabase Auth exposes an admin endpoint to issue test-mode OTPs, will
// extend this spec to drive /members empty-state landing.
//
// This spec is env-gated: when SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY
// are not set we skip (same pattern as Story 1.3 re-auth + 1.4 rate-limit).
// Story 1.8 wires the CI env.

import { expect, test } from "@playwright/test";

const ENV_OK = !!process.env["SUPABASE_TEST_URL"] && !!process.env["SUPABASE_TEST_ANON_KEY"];

test.describe("Flow 5 — collector login", () => {
  test("loads /login welcome screen with phone input + send-code CTA", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { level: 1, name: /bienvenue sur safaricash/i }),
    ).toBeVisible();
    await expect(page.getByLabel("Numéro de téléphone")).toBeVisible();
    await expect(page.getByRole("button", { name: /recevoir le code/i })).toBeDisabled();
  });

  test("disables the CTA until a valid +221 phone is entered", async ({ page }) => {
    await page.goto("/login");
    const cta = page.getByRole("button", { name: /recevoir le code/i });
    const input = page.getByLabel("Numéro de téléphone");
    await input.fill("123");
    await expect(cta).toBeDisabled();
    await input.fill("+221777915898");
    await expect(cta).toBeEnabled();
  });

  test("routes an unregistered phone to /non-registered dead-end", async ({ page }) => {
    test.skip(!ENV_OK, "SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY not set — Story 1.8 wires CI");

    await page.goto("/login");
    const input = page.getByLabel("Numéro de téléphone");
    // A random +221 phone that (almost certainly) is not provisioned.
    const randomPhone = `+22177${Math.floor(1e9 + Math.random() * 8e9)
      .toString()
      .slice(-9)}`;
    await input.fill(randomPhone);
    await page.getByRole("button", { name: /recevoir le code/i }).click();

    await expect(page).toHaveURL(/\/non-registered$/);
    await expect(page.getByRole("heading", { name: /numéro non enregistré/i })).toBeVisible();

    // Founder support phone exposed as tel:+221777915898 (single-source-of-
    // truth constant in src/lib/contact.ts).
    const callCta = page.getByRole("link", { name: /appeler safaricash/i });
    await expect(callCta).toHaveAttribute("href", "tel:+221777915898");
  });
});
