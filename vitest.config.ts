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
