// Story 6.4 — receipt-token regex defence.
//
// Story 6.3 generates tokens via `encode(gen_random_bytes(16), 'hex')` —
// 16 bytes → 32 lowercase-hex chars (128 bits of entropy, NFR-S3). The
// Worker rejects malformed paths BEFORE any Supabase round trip so
// scanning probes don't burn DB capacity.

const TOKEN_REGEX = /^[0-9a-f]{32}$/;

export function tokenIsValid(token: string): boolean {
  return TOKEN_REGEX.test(token);
}
