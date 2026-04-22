// Story 2.3 — Contact Picker API browser-support helper.
//
// Reality: navigator.contacts.select is Chromium-Android only (since
// Chrome 80, May 2020). iOS Safari, Firefox, and desktop Chromium do
// NOT expose it — there is no polyfill, no third-party API.
//
// Used to (a) hide the "Importer depuis les contacts" CTA on /members/new
// when unsupported, and (b) gate the /members/import route to render a
// fallback screen instead of attempting to call the picker.

interface ContactsManager {
  select?: (props: string[], options?: { multiple?: boolean }) => Promise<unknown>;
}

interface NavigatorWithContacts extends Navigator {
  contacts?: ContactsManager;
}

export function isContactPickerSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as NavigatorWithContacts;
  return typeof nav.contacts?.select === "function";
}
