import { expect, test } from "@playwright/test";

test("loads the SafariCash dev server and lands on /login with the welcome heading", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("SafariCash");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /bienvenue sur safaricash/i }),
  ).toBeVisible();
});
