import { expect, test } from "@playwright/test";

/** Signed-out browsing (Requirement 3.4). Runs against any deploy; needs data to assert counts. */
test.describe("public browsing", () => {
  test("landing links to browse and sign in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("BookerReads");
    await expect(page.getByRole("link", { name: /browse central-east/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /get started/i })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  test("terms and privacy render", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Terms");
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Privacy");
  });

  test("manifest and service worker are served", async ({ request }) => {
    const m = await request.get("/manifest.webmanifest");
    expect(m.ok()).toBeTruthy();
    const json = await m.json();
    expect(json.icons.some((i: { sizes: string }) => i.sizes === "512x512")).toBeTruthy();
    const sw = await request.get("/sw.js");
    expect(sw.ok()).toBeTruthy();
    expect(sw.headers()["cache-control"]).toContain("max-age=0");
  });

  test("member routes redirect to login when signed out", async ({ page }) => {
    await page.goto("/shelf");
    await expect(page).toHaveURL(/\/login\?next=%2Fshelf/);
  });

  test("admin is not discoverable when signed out", async ({ page }) => {
    const res = await page.goto("/admin");
    // Middleware redirects to login; the layout would 404 a signed-in non-admin.
    expect([302, 307, 200]).toContain(res?.status() ?? 0);
    await expect(page).toHaveURL(/\/login/);
  });
});
