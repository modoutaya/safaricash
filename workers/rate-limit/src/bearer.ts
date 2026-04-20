// Bearer-token comparison for service-role bypass (Story 1.4 review fix B1).
//
// Why this lives separate from `jwt.ts`:
// The Supabase service_role token is a STATIC, project-scoped JWT (operator
// pastes it from `supabase status` or the Supabase dashboard) — it never
// rotates per request. We treat it as an opaque shared secret and compare
// the raw bearer string to the known SUPABASE_SERVICE_ROLE_KEY env value.
//
// Why NOT trust the decoded `role: "service_role"` claim:
// JWTs in this worker are NOT signature-verified (cost trade-off documented
// in jwt.ts). Anyone could craft a forged JWT with `{role: "service_role"}`
// in the payload. Trusting that claim defeats the entire rate-limit:
// attackers would get unlimited proxy throughput, then burn Termii SMS
// budget via /functions/v1/re-auth — exactly what this story closes.
//
// Constant-time comparison prevents a timing oracle on the service-role
// key (which would give attackers a remote brute-force path against a
// 256-bit JWT — practically infeasible, but free defense-in-depth).

/** Constant-time string comparison; returns false for length mismatch. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Returns true iff the Authorization header carries the legitimate
 * SUPABASE_SERVICE_ROLE_KEY. Returns false for missing header, missing env,
 * malformed Bearer, or any mismatch.
 */
export function isLegitimateServiceRole(
  authHeader: string | null,
  expectedServiceRoleKey: string | undefined,
): boolean {
  if (!authHeader) return false;
  if (!expectedServiceRoleKey || expectedServiceRoleKey.length === 0) return false;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const presented = (m[1] as string).trim();
  const expected = expectedServiceRoleKey.trim();
  return constantTimeEqual(presented, expected);
}
