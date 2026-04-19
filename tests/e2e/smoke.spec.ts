import { expect, test } from "@playwright/test";

test("loads the SafariCash dev server with the correct page title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("SafariCash");
  await expect(page.getByRole("heading", { level: 1, name: /safaricash/i })).toBeVisible();
});
