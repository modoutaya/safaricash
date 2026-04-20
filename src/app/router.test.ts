// Smoke test: the router object is a well-formed data-router with the
// expected top-level public routes. If someone accidentally removes /login
// or /non-registered, this test fails loudly.

import { describe, expect, it } from "vitest";

import { router } from "@/app/router";

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
