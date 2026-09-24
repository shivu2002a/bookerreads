import { expect, test } from "@playwright/test";
import { FULL, mockScanner, SEED_PHONES, signIn, takePhoto } from "./helpers";

/**
 * Task 24.4: signup -> onboard -> scan -> list -> second user requests -> accept
 * -> meet-up handoff both sides -> return -> verified badge. Needs a local
 * Supabase with the seed applied (`supabase start && pnpm db:migrate && pnpm db:seed`)
 * and E2E_FULL=1. Uses test-OTP numbers, so no SMS is sent.
 */
test.describe("loan lifecycle", () => {
  test.skip(!FULL, "requires a seeded local Supabase (E2E_FULL=1)");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  const ISBN = "9780062316097"; // Sapiens, present in the fixture

  test("a brand-new member signs up, onboards, and lists a scanned book", async ({ browser }) => {
    const ctx = await browser.newContext();
    await mockScanner(ctx, ISBN);
    const page = await ctx.newPage();

    // Yash is seeded as `registered` with no copies and a 0-day-old account.
    await signIn(page, SEED_PHONES.yash);
    if (page.url().includes("/onboarding")) {
      await page.getByLabel("Display name").fill("Yash");
      await page.getByRole("button", { name: /start listing/i }).click();
      await page.waitForURL(/\/shelf/);
    }

    await page.goto("/shelf/add");
    await expect(page.getByRole("heading", { name: "Add a book" })).toBeVisible();
    // The fake detector fires on the first frame; the wizard looks the ISBN up and shows the confirm step.
    await expect(page.getByRole("button", { name: /yes, this is it/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /yes, this is it/i }).click();
    await takePhoto(page, /photo of your copy/i);
    await page.getByRole("button", { name: /add to my shelf/i }).click();
    await expect(page.getByText(/is on your shelf/)).toBeVisible();

    await page.goto("/shelf");
    await expect(page.getByText("Sapiens").first()).toBeVisible();
    await ctx.close();
  });

  test("request, accept, meet-up handoff, return, verification", async ({ browser }) => {
    // Lender: Ananya (active, seeded). Borrower: Rohan (active, seeded).
    const lenderCtx = await browser.newContext();
    const borrowerCtx = await browser.newContext();
    const lender = await lenderCtx.newPage();
    const borrower = await borrowerCtx.newPage();
    await signIn(lender, SEED_PHONES.ananya);
    await signIn(borrower, SEED_PHONES.rohan);

    // Borrower finds an available copy owned by Ananya via her public shelf.
    await lender.goto("/profile");
    const shelfHref = await lender.getByRole("link", { name: "public shelf" }).getAttribute("href");
    await borrower.goto(shelfHref!);
    await borrower
      .getByRole("link")
      .filter({ has: borrower.locator("img, span") })
      .first()
      .click();
    await borrower.waitForURL(/\/b\//);
    const request = borrower.getByRole("link", { name: /^request$/i }).first();
    await expect(request).toBeVisible();
    await request.click();
    await borrower.waitForURL(/\/loans\/new/);
    await borrower.getByRole("button", { name: /send request/i }).click();
    await borrower.waitForURL(/\/loans\/[0-9a-f-]+$/);
    const loanUrl = borrower.url();

    // Lender accepts with the in-hand confirmation.
    await lender.goto("/requests");
    await lender
      .getByRole("button", { name: /^accept$/i })
      .first()
      .click();
    await lender.getByText(/in my hands right now/i).click();
    await lender.getByRole("button", { name: /confirm accept/i }).click();
    await expect(lender.getByText(/accepted\./i)).toBeVisible();

    // Both confirm the handover with photos.
    for (const p of [lender, borrower]) {
      await p.goto(loanUrl);
      await takePhoto(p, /photo of the book at handover/i);
      await p.getByRole("button", { name: /handed over/i }).click();
      await expect(p.getByText(/confirmed/i).first()).toBeVisible();
    }
    await borrower.goto(loanUrl);
    await expect(borrower.getByText(/due back/i)).toBeVisible();

    // Return: borrower photo, then lender photo + condition.
    await borrower.goto(loanUrl);
    await takePhoto(borrower, /as returned/i);
    await borrower.getByRole("button", { name: /^returned$/i }).click();
    await lender.goto(loanUrl);
    await takePhoto(lender, /as returned/i);
    await lender.getByRole("button", { name: /^good$/i }).click();
    await lender.getByRole("button", { name: /^received$/i }).click();
    await lender.goto(loanUrl);
    await expect(lender.getByText(/loan complete/i)).toBeVisible();

    // The copy now carries the verified badge on the lender's shelf.
    await lender.goto("/shelf");
    await expect(lender.getByText("Verified").first()).toBeVisible();

    await lenderCtx.close();
    await borrowerCtx.close();
  });
});
