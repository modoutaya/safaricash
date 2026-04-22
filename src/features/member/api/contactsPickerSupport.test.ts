// Story 2.3 — isContactPickerSupported tests.
import { afterEach, describe, expect, it } from "vitest";

import { isContactPickerSupported } from "./contactsPickerSupport";

const originalContacts = (navigator as { contacts?: unknown }).contacts;

afterEach(() => {
  if (originalContacts === undefined) {
    delete (navigator as { contacts?: unknown }).contacts;
  } else {
    (navigator as { contacts?: unknown }).contacts = originalContacts;
  }
});

describe("isContactPickerSupported", () => {
  it("returns false when navigator.contacts is undefined", () => {
    delete (navigator as { contacts?: unknown }).contacts;
    expect(isContactPickerSupported()).toBe(false);
  });

  it("returns false when navigator.contacts.select is missing", () => {
    (navigator as { contacts?: unknown }).contacts = {} as unknown;
    expect(isContactPickerSupported()).toBe(false);
  });

  it("returns true when navigator.contacts.select is a function", () => {
    (navigator as { contacts?: unknown }).contacts = {
      select: () => Promise.resolve([]),
    };
    expect(isContactPickerSupported()).toBe(true);
  });
});
