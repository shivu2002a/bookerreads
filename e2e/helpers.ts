import { expect, type BrowserContext, type Page } from "@playwright/test";

/** Seeded test-OTP numbers from supabase/config.toml; code is always 123456 locally. */
export const SEED_PHONES = {
  ananya: "9999900001",
  rohan: "9999900002",
  meera: "9999900003",
  yash: "9999900030",
} as const;
export const TEST_OTP = "123456";

/** Full flows need a running `supabase start` with the seed applied. */
export const FULL = process.env.E2E_FULL === "1";

export async function signIn(page: Page, phone: string) {
  await page.goto("/login");
  await page.getByLabel("Mobile number").fill(phone);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("6-digit code").fill(TEST_OTP);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/**
 * Replaces the native BarcodeDetector with one that "sees" the given ISBN on
 * the first frame, and stubs the camera so getUserMedia resolves. Must be
 * added before navigation.
 */
export async function mockScanner(context: BrowserContext, isbn13: string) {
  await context.addInitScript((isbn) => {
    class FakeDetector {
      static getSupportedFormats() {
        return Promise.resolve(["ean_13"]);
      }
      detect() {
        return Promise.resolve([{ rawValue: isbn, format: "ean_13" }]);
      }
    }
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const stream = (
      canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }
    ).captureStream(10);
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => Promise.resolve(stream),
      configurable: true,
    });
  }, isbn13);
}

/** A tiny fresh JPEG so PhotoCapture's gallery heuristic (lastModified) passes. */
export function freshJpeg() {
  // 1x1 JPEG
  const b64 =
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
  return { name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") };
}

export async function takePhoto(page: Page, label: RegExp | string) {
  const input = page.locator('input[type="file"][capture]').first();
  await input.setInputFiles(freshJpeg());
  await expect(page.getByText("Uploaded")).toBeVisible({ timeout: 15_000 });
  void label;
}
