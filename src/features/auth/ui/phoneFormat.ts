// Phone-format helpers for the Senegal collector login flow.
// Story 1.5: normalize raw user input into E.164 and mask the number in
// confirmation UI so a mistyped digit is visible WITHOUT leaking the full
// phone back to a shoulder-surfer. See AC #2 + AC #6.

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

/**
 * Mask an E.164 Senegal phone for OTP confirmation copy.
 * Preserves the +221 prefix and the last 6 digits; replaces digits 4-5
 * (0-indexed positions 4 and 5 of the national number) with X so the user
 * can verify it's the right line without exposing the whole number again
 * on a shared device.
 *
 * Example: "+221777915898" → "+221 77 X 91 58 98"
 *   - positions 0,1 kept (77)
 *   - position 2 masked (X)
 *   - positions 3,4 kept (91)
 *   - positions 5,6 kept (58)
 *   - positions 7,8 kept (98)
 *
 * If the input is not a valid Senegal phone, returns the input unchanged —
 * the caller should never feed invalid data here, but we prefer a no-op to
 * a throw in UI code.
 */
export function maskPhone(phone: string): string {
  if (!isValidSenegalPhone(phone)) return phone;
  const national = phone.slice(4);
  const d = national.split("");
  return `+221 ${d[0]}${d[1]} ${"X"} ${d[3]}${d[4]} ${d[5]}${d[6]} ${d[7]}${d[8]}`;
}
