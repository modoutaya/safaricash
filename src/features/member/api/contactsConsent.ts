// Story 2.3 — Contact-import consent storage.
//
// localStorage flag — UX commitment, NOT a security boundary. Any user
// can edit it via DevTools. The actual authorization is the OS-native
// Contact Picker (Chrome shows it; the user picks; we receive only the
// selected contacts). Our flag's purpose: we promise to never invoke
// `navigator.contacts.select()` without it set. See spec § AC #8.

const CONSENT_STORAGE_KEY = "safaricash_contacts_consent";
const GRANTED_VALUE = "granted";

function safeLocalStorage(): Storage | null {
  // jsdom + SSR / non-browser callers — fail closed.
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function hasContactsConsent(): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  return ls.getItem(CONSENT_STORAGE_KEY) === GRANTED_VALUE;
}

export function grantContactsConsent(): void {
  safeLocalStorage()?.setItem(CONSENT_STORAGE_KEY, GRANTED_VALUE);
}

export function revokeContactsConsent(): void {
  safeLocalStorage()?.removeItem(CONSENT_STORAGE_KEY);
}
