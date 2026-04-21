// Smoke test: the router object is a well-formed data-router with the
// expected top-level public route (/login). If someone accidentally
// removes /login, this test fails loudly.

import { describe, expect, it, vi } from "vitest";

// The router module transitively imports the Supabase client, which validates
// VITE_SUPABASE_* env at module-init time. CI does not ship a .env.local, so
// we stub the client — this test only exercises the router's route table.
vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: () => ({
      select: () => ({
        limit: () => Promise.resolve({ count: 0, data: null, error: null }),
      }),
    }),
  },
}));

const { router } = await import("@/app/router");

describe("router", () => {
  it("exposes the /login public route (PRD v1.3: no /non-registered)", () => {
    const allPaths = router.routes.flatMap(function collect(r): string[] {
      const self = r.path ? [r.path] : [];
      const kids = (r.children ?? []).flatMap(collect);
      return [...self, ...kids];
    });
    expect(allPaths).toContain("/login");
    // /non-registered was removed in Story 1.5b — signInWithPassword
    // returns invalid_credentials for both unregistered phones and
    // wrong passwords, so the dead-end route is no longer needed.
    expect(allPaths).not.toContain("/non-registered");
  });

  it("is a browser (history) router", () => {
    // createBrowserRouter exposes a `navigate` function; legacy memory
    // router does not expose the same surface.
    expect(typeof router.navigate).toBe("function");
  });
});
