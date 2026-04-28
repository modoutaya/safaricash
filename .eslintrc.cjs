/* eslint-env node */

// Brand-token hex codes mirrored from tailwind.config.ts. Hard-coding any of
// these in JSX/TSX bypasses the design-token contract, so block them at lint
// time and force usage of the Tailwind utility classes instead.
const BRAND_HEX_REGEX =
  "#(?:1D9E75|16875F|085041|064236|053128|031E18|F0FAF6|E1F5EE|C2EADC|94D9C0|5BC09D|FAEEDA|633806|854F0B|FAECE7|712B13|E24B4A|E6F1FB|0C447C|B5D4F4|F8F9F8)(?:[0-9A-F]{2})?";
const BRAND_HEX_SELECTOR_BODY = `value=/^${BRAND_HEX_REGEX}$/i`;
const BRAND_HEX_TEMPLATE_BODY = `value.raw=/${BRAND_HEX_REGEX}/i`;

module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  settings: {
    react: { version: "18" },
    "import/resolver": {
      typescript: { project: "./tsconfig.json" },
      node: true,
    },
  },
  plugins: ["@typescript-eslint", "react", "react-hooks", "jsx-a11y", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:react/jsx-runtime",
    "plugin:react-hooks/recommended",
    "plugin:jsx-a11y/recommended",
    "prettier",
  ],
  ignorePatterns: [
    "dist",
    "node_modules",
    "playwright-report",
    "test-results",
    "coverage",
    ".husky",
    "_bmad",
    "_bmad-output",
  ],
  rules: {
    "react/prop-types": "off",
    "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    // Story 1.8 — jsx-a11y rule upgrades beyond the `recommended` preset.
    // Rationale documented in story 1-8-ci-pipeline-gates.md § AC 5.
    "jsx-a11y/no-autofocus": "error",
    "jsx-a11y/label-has-associated-control": ["error", { assert: "either" }],
    // react-router-dom's <Link to="..."> is a valid anchor; teach the rule
    // so the existing codebase doesn't trip on it.
    "jsx-a11y/anchor-is-valid": [
      "error",
      {
        components: ["Link"],
        specialLink: ["to"],
        aspects: ["noHref", "invalidHref", "preferButton"],
      },
    ],
    // Cross-feature internal imports must go through the feature's index.ts barrel.
    // Severity is "error" so CI's --max-warnings=0 is not the only thing keeping
    // layering honest.
    "import/no-internal-modules": [
      "error",
      {
        forbid: ["@/features/*/!(index)", "@/features/*/!(index).*"],
      },
    ],
    // Hard-coded SafariCash brand hex codes are forbidden in app code. Configs
    // (where the tokens are defined) and tests are exempted via overrides.
    "no-restricted-syntax": [
      "error",
      {
        selector: `Literal[${BRAND_HEX_SELECTOR_BODY}]`,
        message:
          "Hard-coded SafariCash brand hex codes are forbidden in app code. Use the Tailwind tokens defined in tailwind.config.ts.",
      },
      {
        selector: `TemplateElement[${BRAND_HEX_TEMPLATE_BODY}]`,
        message:
          "Hard-coded SafariCash brand hex codes are forbidden in template literals. Use the Tailwind tokens defined in tailwind.config.ts.",
      },
    ],
  },
  overrides: [
    // Story 3.2 — domain/cycle is a pure function library. Forbid imports
    // from infrastructure / features / components / app / React / Supabase
    // / sonner / i18n. Test files in the same directory are exempt
    // (they may need vitest, fast-check, etc.).
    {
      files: ["src/domain/cycle/**/*.ts"],
      excludedFiles: ["src/domain/cycle/**/*.test.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              "@/infrastructure/*",
              "@/features/*",
              "@/components/*",
              "@/app/*",
              "@/i18n/*",
              "react",
              "react-dom",
              "react-router-dom",
              "sonner",
              "@supabase/*",
              "@hookform/*",
              "react-hook-form",
            ],
          },
        ],
      },
    },
    {
      files: ["src/components/ui/**/*.{ts,tsx}", "tailwind.config.ts", "vite.config.ts"],
      rules: { "no-restricted-syntax": "off" },
    },
    // Story 6.4 — receipt-url Worker has no Tailwind build step (it ships
    // inline CSS in a no-JS HTML page per UX-DR19). The saver-facing
    // brand palette is intentional here; brand-hex usage is sanctioned.
    {
      files: ["workers/receipt-url/src/render.ts"],
      rules: { "no-restricted-syntax": "off" },
    },
    {
      files: ["**/*.test.{ts,tsx}", "tests/**/*.{ts,tsx}"],
      env: { node: true },
      rules: {
        "no-restricted-syntax": "off",
        // Playwright fixtures pass a `use(value)` callback — react-hooks
        // misidentifies it as a React Hook. Tests never render React hooks
        // anyway (RTL uses render()), so the rule is safe to disable in
        // the tests/ tree.
        "react-hooks/rules-of-hooks": "off",
      },
    },
    {
      // Config files at the root are linted — but they may legitimately import
      // from devDependencies (e.g. tailwindcss-animate, @vitejs/plugin-react).
      files: ["./*.config.{ts,js,cjs}", "./.eslintrc.cjs"],
      env: { node: true },
      parserOptions: { sourceType: "script" },
      rules: {
        "import/no-internal-modules": "off",
        "@typescript-eslint/no-var-requires": "off",
      },
    },
  ],
};
