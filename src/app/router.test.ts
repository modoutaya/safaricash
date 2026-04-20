// Smoke test: the router object is a well-formed data-router with the
// expected top-level public routes. If someone accidentally removes /login
// or /non-registered, this test fails loudly.

import { describe, expect, it, vi } from "vitest";

// The router module transitively imports the Supabase client, which validates
// VITE_SUPABASE_* env at module-init time. CI does not ship a .env.local, so
// we stub the client — this test only exercises the router's route table.
vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {},
}));

const { router } = await import("@/app/router");

describe("router", () => {
  it("exposes the /login and /non-registered public routes", () => {
    const allPaths = router.routes.flatMap(function collect(r): string[] {
      const self = r.path ? [r.path] : [];
      const kids = (r.children ?? []).flatMap(collect);
      return [...self, ...kids];
    });
    expect(allPaths).toContain("/login");
    expect(allPaths).toContain("/non-registered");
  });

  it("is a browser (history) router", () => {
    // createBrowserRouter exposes a `navigate` function; legacy memory
    // router does not expose the same surface.
    expect(typeof router.navigate).toBe("function");
  });
});
