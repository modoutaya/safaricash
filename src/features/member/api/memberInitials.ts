// Story 2.1 — 2-letter initial derivation for MemberCard avatar.
//
// Rules:
//   - Multi-word name → first letter of first 2 words.
//   - Single-word name → first 2 characters.
//   - Empty / whitespace-only → "??" (defensive; name is NOT NULL in schema).
//
// Always uppercase. Uses locale-aware upper to handle diacritics correctly.

export function memberInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "??";

  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (words.length >= 2) {
    return (words[0]!.charAt(0) + words[1]!.charAt(0)).toLocaleUpperCase();
  }
  // Single word — take the first 2 characters.
  return trimmed.slice(0, 2).toLocaleUpperCase();
}
