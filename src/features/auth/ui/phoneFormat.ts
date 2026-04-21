// Phone-format helpers for the Senegal collector login flow.
// Story 1.5b — maskPhone was removed alongside the OTP confirmation
// screen (PRD v1.3 auth pivot).

const SENEGAL_COUNTRY_CODE = "+221";
const SENEGAL_E164_REGEX = /^\+221[0-9]{9}$/;

/** Strip spaces, dashes, parentheses; return only + and digits. */
function sanitize(input: string): string {
  return input.replace(/[\s\-().]/g, "");
}

/**
 * Normalize user-entered phone into E.164 Senegal format.
 * Rules:
 *   - strips spaces/dashes
 *   - if input already starts with +221 (9 digits remaining) → keep
 *   - if input starts with 221 (no plus) → prepend +
 *   - if input is a 9-digit local number → prepend +221
 *   - if input starts with 00221 → replace with +221
 * Any other shape is returned sanitized and lets the validator fail cleanly
 * — we do NOT silently "guess" a phone that does not match Senegal's format.
 */
export function formatE164(raw: string): string {
  const cleaned = sanitize(raw);
  if (cleaned === "") return "";
  if (cleaned.startsWith("+221")) return cleaned;
  if (cleaned.startsWith("00221")) return `+${cleaned.slice(2)}`;
  if (cleaned.startsWith("221") && cleaned.length === 12) return `+${cleaned}`;
  if (/^[0-9]{9}$/.test(cleaned)) return `${SENEGAL_COUNTRY_CODE}${cleaned}`;
  return cleaned;
}

/** True if the string is a well-formed Senegal E.164 mobile (+221 + 9 digits). */
export function isValidSenegalPhone(candidate: string): boolean {
  return SENEGAL_E164_REGEX.test(candidate);
}
