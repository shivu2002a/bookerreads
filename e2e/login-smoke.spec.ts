import { expect, test } from "@playwright/test";
import { FULL, SEED_PHONES, signIn } from "./helpers";

/** Quick check that phone OTP login lands on the shelf. Needs Supabase test OTPs configured. */
test("seeded admin can sign in with the test OTP", async ({ page }) => {
  test.skip(!FULL, "requires Supabase test OTPs (E2E_FULL=1)");
  await signIn(page, SEED_PHONES.ananya);
  await expect(page).toHaveURL(/\/shelf/);
  await expect(page.getByRole("heading", { name: "My shelf" })).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});
