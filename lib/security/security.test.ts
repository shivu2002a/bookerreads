import { describe, expect, it } from "vitest";
import { safeEqual } from "./constant-time";
import { assertCronSecret, isCronRequestAuthorised } from "./cron";
import {
  signHmacSha256Hex,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
} from "./webhook-signature";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("safeEqual", () => {
  it("compares equal and unequal strings without throwing on length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("cron secret", () => {
  it("accepts a bearer token or the custom header", () => {
    expect(
      isCronRequestAuthorised(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET),
    ).toBe(true);
    expect(isCronRequestAuthorised(new Headers({ "x-cron-secret": SECRET }), SECRET)).toBe(true);
  });

  it("rejects wrong, missing, or empty secrets", () => {
    expect(isCronRequestAuthorised(new Headers({ authorization: "Bearer nope" }), SECRET)).toBe(
      false,
    );
    expect(isCronRequestAuthorised(new Headers(), SECRET)).toBe(false);
    expect(isCronRequestAuthorised(new Headers({ "x-cron-secret": "" }), "")).toBe(false);
  });

  it("assertCronSecret returns a 401 response or null", () => {
    const bad = assertCronSecret(new Request("http://x/api/cron/daily"), SECRET);
    expect(bad?.status).toBe(401);
    const ok = assertCronSecret(
      new Request("http://x/api/cron/daily", { headers: { authorization: `Bearer ${SECRET}` } }),
      SECRET,
    );
    expect(ok).toBeNull();
  });
});

describe("razorpay signatures", () => {
  const body = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_1" } } },
  });

  it("verifies a webhook signed with the secret", () => {
    const sig = signHmacSha256Hex(body, SECRET);
    expect(verifyRazorpayWebhookSignature(body, sig, SECRET)).toBe(true);
    expect(verifyRazorpayWebhookSignature(body, ` ${sig} `, SECRET)).toBe(true);
  });

  it("rejects a tampered body, wrong secret, or missing header", () => {
    const sig = signHmacSha256Hex(body, SECRET);
    expect(verifyRazorpayWebhookSignature(body + " ", sig, SECRET)).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, sig, "other-secret")).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, sig, "")).toBe(false);
  });

  it("verifies checkout signatures over order|payment", () => {
    const sig = signHmacSha256Hex("order_1|pay_1", SECRET);
    expect(verifyRazorpayCheckoutSignature(["order_1", "pay_1"], sig, SECRET)).toBe(true);
    expect(verifyRazorpayCheckoutSignature(["order_2", "pay_1"], sig, SECRET)).toBe(false);
  });
});
