import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: true,
    // Pin Vitest's discovery root to the repo root so nested tsconfig.json
    // files (e.g. workers/rate-limit/tsconfig.json) don't get treated as
    // standalone projects and try to load a non-existent vitest.setup.ts.
    root: __dirname,
    include: ["src/**/*.{test,spec}.ts", "workers/**/*.{test,spec}.ts"],
    exclude: [
      "node_modules",
      "dist",
      "tests/e2e",
      "playwright-report",
      "test-results",
      // Edge Function tests run on Deno via `npm run test:edge`
      "supabase/functions/**",
    ],
  },
});
