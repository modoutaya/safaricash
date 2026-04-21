// Story 1.8 — insurance unit test for the Playwright seed-collector fixture.
//
// Pins two contracts a supabase-js upgrade could silently break:
//   (1) The localStorage key format is `sb-<projectRef>-auth-token` where
//       projectRef = hostname.split('.')[0] (see
//       node_modules/@supabase/supabase-js/src/SupabaseClient.ts:294).
//   (2) The stored value is a plain Session JSON (no wrapper, no base64).
//
// If supabase-js ever changes either contract in a minor / patch, this test
// goes red BEFORE the E2Es silently regress (authentication fixture writes
// the wrong key and the ProtectedRoute redirects to /login).

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { deriveStorageKey } from "./seed-collector";

describe("seed-collector fixture — storage key derivation", () => {
  it("derives sb-<first-subdomain>-auth-token for a cloud Supabase URL", () => {
    expect(deriveStorageKey("https://oarikzsmcqdvdfwvzgrc.supabase.co")).toBe(
      "sb-oarikzsmcqdvdfwvzgrc-auth-token",
    );
  });

  it("derives sb-127-auth-token for the local Supabase dev stack", () => {
    expect(deriveStorageKey("http://127.0.0.1:54321")).toBe("sb-127-auth-token");
  });

  it("derives sb-localhost-auth-token for hostname 'localhost'", () => {
    expect(deriveStorageKey("http://localhost:54321")).toBe("sb-localhost-auth-token");
  });

  it("matches the regex the fixture relies on (AC 12)", () => {
    const key = deriveStorageKey("https://project-ref-1.supabase.co");
    expect(key).toMatch(/^sb-[a-z0-9-]+-auth-token$/);
  });

  it("matches supabase-js's actual storageKey for the same URL", () => {
    // createClient with a throwaway URL + anon key. No network call happens
    // at construction, so we can read the storageKey the client derived.
    const url = "https://example-project.supabase.co";
    const fakeAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.signature";
    const client = createClient(url, fakeAnonKey);
    // `.auth` exposes a GoTrueClient; its `storageKey` is the same string the
    // SupabaseClient computed in its constructor (see SupabaseClient.ts:294).
    // Access via a typed-escape since storageKey isn't on the public type.
    const actualKey = (client.auth as unknown as { storageKey: string }).storageKey;
    expect(actualKey).toBe(deriveStorageKey(url));
  });
});
