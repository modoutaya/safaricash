/* eslint-env node */
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
    "*.config.js",
    "*.config.ts",
    "*.config.cjs",
  ],
  rules: {
    "react/prop-types": "off",
    "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    // Block cross-feature internal imports — features must export from their index.ts
    "import/no-internal-modules": [
      "warn",
      {
        forbid: ["@/features/*/!(index)", "@/features/*/!(index).*"],
      },
    ],
    // Ban hard-coded SafariCash brand hex codes — must go through Tailwind tokens
    "no-restricted-syntax": [
      "error",
      {
        selector: "Literal[value=/#1[Dd]9[Ee]75|#16875[Ff]|#085041|#FAEEDA|#FAECE7|#E6F1FB/]",
        message:
          "Hard-coded SafariCash brand hex codes are forbidden. Use Tailwind tokens defined in tailwind.config.ts.",
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
  ],
};
