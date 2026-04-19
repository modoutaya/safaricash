// JWT trust-and-decode helpers (Story 1.4 AC #3 + #6).
//
// Extracts `sub` (collector_id) and `role` claims WITHOUT verifying the
// signature. Documented trade-off in the story spec: forged JWTs only burn
// rate-limit quota for fake collector_ids, which is bounded by the same
// 100/min cap and self-limiting. Supabase Edge Functions perform full
// signature verification downstream — the worker is not the security
// boundary, only the throttle.

export type DecodedJwt = {
  collectorId: string;
  /** Supabase Auth role: 'anon' | 'authenticated' | 'service_role' */
  role: string;
};

/** Base64-URL decode (no padding, dash/underscore alphabet). */
function base64UrlDecode(input: string): string {
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}

/**
 * Decode a Supabase Auth JWT's `sub` and `role` claims.
 * Returns null on missing header, malformed JWT, or missing `sub`.
 *
 * NEVER verify the signature here — this is a trust-and-decode shortcut.
 * See Story 1.4 § Anti-patterns to avoid.
 */
export function decodeJwt(authHeader: string | null): DecodedJwt | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const jwt = m[1] as string;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;

  let payload: Record<string, unknown>;
  try {
    const decoded = base64UrlDecode(parts[1] as string);
    payload = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }

  const sub = payload["sub"];
  const role = payload["role"];
  if (typeof sub !== "string" || sub.length === 0) return null;
  return {
    collectorId: sub,
    role: typeof role === "string" ? role : "authenticated",
  };
}

/** Convenience: is this JWT a Supabase service-role token (bypass rate limit)? */
export function isServiceRole(jwt: DecodedJwt | null): boolean {
  return jwt?.role === "service_role";
}
