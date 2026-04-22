// Story 2.3 — contactsConsent helper tests.
import { beforeEach, describe, expect, it } from "vitest";

import { grantContactsConsent, hasContactsConsent, revokeContactsConsent } from "./contactsConsent";

describe("contactsConsent", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("hasContactsConsent returns false when no key is set", () => {
    expect(hasContactsConsent()).toBe(false);
  });

  it("grantContactsConsent then hasContactsConsent returns true", () => {
    grantContactsConsent();
    expect(hasContactsConsent()).toBe(true);
  });

  it("revokeContactsConsent clears the flag", () => {
    grantContactsConsent();
    revokeContactsConsent();
    expect(hasContactsConsent()).toBe(false);
  });

  it("hasContactsConsent ignores unrelated localStorage entries", () => {
    window.localStorage.setItem("safaricash_contacts_consent", "maybe");
    expect(hasContactsConsent()).toBe(false);
  });
});
