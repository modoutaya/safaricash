// Story 1.8 — shared Playwright helper for NFR-A1 a11y assertions.
//
// Policy (documented here so reviewers and future Claudes share the contract):
//   - Tag filter: `wcag2a` + `wcag2aa` only. AAA is intentionally excluded —
//     NFR-A1 commits to WCAG 2.1 AA (see prd.md NFR-A1 and
//     architecture.md:59).
//   - Severity gate: `serious` + `critical` violations FAIL the test.
//     `minor` + `moderate` violations are LOGGED (via test annotation) but
//     do NOT fail — Radix + shadcn components emit moderate violations
//     out-of-the-box that require upstream patches. Blocking on them at
//     Story 1.8 would stall the sprint. Revisit when upstream issues land.
//   - Call per page-state: helper should be invoked after each meaningful
//     navigation or DOM update that's visible to the user. Do NOT put it in
//     `afterEach`: some tests land on a redirect page where the a11y
//     assertion context is lost (we want to scan both the pre- and
//     post-redirect state).

import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const SERIOUS_IMPACTS = new Set(["serious", "critical"]);

/** Scan the current page with axe-core and fail on serious/critical
 *  violations. `context` is a short human-readable label included in the
 *  error message so failures identify which page-state regressed. */
export async function expectNoA11yViolations(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();

  const blocking = results.violations.filter((v) => SERIOUS_IMPACTS.has(v.impact ?? ""));
  const informational = results.violations.filter((v) => !SERIOUS_IMPACTS.has(v.impact ?? ""));

  if (informational.length > 0) {
    // Surface in the Playwright report but don't fail.
    // eslint-disable-next-line no-console -- this is test output, not app code
    console.warn(
      `[axe][${context}] ${informational.length} minor/moderate violation(s):`,
      informational.map((v) => `${v.id} (${v.impact})`).join(", "),
    );
  }

  expect(
    blocking,
    `axe serious/critical violations (${context}):\n${JSON.stringify(blocking, null, 2)}`,
  ).toEqual([]);
}
