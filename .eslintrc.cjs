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
    {
      files: ["src/components/ui/**/*.{ts,tsx}", "tailwind.config.ts", "vite.config.ts"],
      rules: { "no-restricted-syntax": "off" },
    },
    {
      files: ["**/*.test.{ts,tsx}", "tests/**/*.{ts,tsx}"],
      env: { node: true },
      rules: { "no-restricted-syntax": "off" },
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
