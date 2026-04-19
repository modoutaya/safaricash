// RLS-equivalent entry-point guard for every Edge Function.
// architecture.md § Authentication & Security: "No custom API endpoint is
// exposed without an RLS-equivalent check at the Edge Function boundary."

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { problem, type Problem } from "./rfc7807.ts";

export type AuthOk = { collectorId: string; jwt: string };
export type AuthErr = { problem: Problem };
export type AuthResult = AuthOk | AuthErr;

/**
 * Validates the caller's Supabase JWT, resolves their collector_id, and
 * verifies a public.users row exists. Returns either the resolved identity
 * or an RFC 7807 problem ready for problemResponse().
 *
 * Uses the anon-key client (no service role) for getUser — service role can
 * be passed in for downstream queries that need to bypass RLS.
 */
export async function assertAuthenticated(
  req: Request,
  anonClient: SupabaseClient,
  serviceClient: SupabaseClient,
): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return {
      problem: problem("auth_unauthenticated", "Missing or malformed Authorization header"),
    };
  }
  const jwt = m[1];

  // Validate JWT against Supabase Auth (uses GoTrue under the hood).
  const { data, error } = await anonClient.auth.getUser(jwt);
  if (error || !data.user) {
    return {
      problem: problem("auth_unauthenticated", "JWT invalid or expired"),
    };
  }
  const collectorId = data.user.id;

  // Verify a public.users row exists — defends against deleted-user JWT replay.
  const { data: userRow, error: userErr } = await serviceClient
    .from("users")
    .select("id")
    .eq("id", collectorId)
    .maybeSingle();
  if (userErr) {
    return {
      problem: problem("internal_unexpected", `users lookup failed: ${userErr.message}`),
    };
  }
  if (!userRow) {
    return {
      problem: problem(
        "auth_user_not_provisioned",
        "Authenticated JWT does not map to a provisioned collector",
      ),
    };
  }

  return { collectorId, jwt };
}

/** Convenience: build an anon Supabase client from env. */
export function buildAnonClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing in Edge Function env");
  }
  return createClient(url, anonKey, { auth: { persistSession: false } });
}

/** Convenience: build a service-role Supabase client from env. */
export function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in Edge Function env");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}
