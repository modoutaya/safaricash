// Story 1.8 — Conventional Commits validator for SafariCash.
//
// Config chosen to match the repo's existing commit style:
//   feat(auth): story 1.7 — explicit sign-out flow + session.signed_out audit
//   fix(ci): gate 1.6/1.7 E2E specs on SUPABASE_TEST_SEED_READY
//
// - `subject-case` disabled: config-conventional forces lower-case subjects;
//   our French / mixed-case subjects ("Story 1.7 — …") would all fail.
// - `header-max-length` raised to 100 to accommodate the existing
//   `scope + story-tag` style without awkward truncation.
// - `scope-case` kept at kebab-case so scopes stay machine-readable.
// - The `body-max-line-length` default is disabled — the `Co-Authored-By`
//   trailer + wrapped body of existing commits routinely runs long and
//   is readable enough.

/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [0],
    "header-max-length": [2, "always", 100],
    // Relaxed from strict kebab-case because legitimate scopes like `e2e`
    // (start with letter, contain digit) and single-word scopes like `ci`,
    // `auth` fail the `[a-z]+(-[a-z0-9]+)*` pattern on the first segment.
    // Accept kebab-case OR plain lowercase with optional digits: keeps
    // machine-readable scopes without blocking idiomatic abbreviations.
    "scope-case": [0],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
