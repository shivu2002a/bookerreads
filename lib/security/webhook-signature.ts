import { createHmac } from "node:crypto";
import { safeEqual } from "./constant-time";

/**
 * Razorpay signs webhooks with HMAC-SHA256 over the raw request body using the
 * webhook secret, hex-encoded, in the `x-razorpay-signature` header.
 * https://razorpay.com/docs/webhooks/validate-test/
 */
export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signatureHeader.trim());
}

/**
 * Razorpay Checkout returns `razorpay_signature` = HMAC-SHA256(key_secret,
 * `${order_id}|${payment_id}`) for one-time payments, and
 * `${payment_id}|${subscription_id}` for subscriptions.
 */
export function verifyRazorpayCheckoutSignature(
  parts: [string, string],
  signature: string | null,
  keySecret: string,
): boolean {
  if (!signature || !keySecret) return false;
  const expected = createHmac("sha256", keySecret).update(parts.join("|")).digest("hex");
  return safeEqual(expected, signature.trim());
}

/**
 * Interakt delivery-status webhooks: HMAC-SHA256 over the raw body with the
 * configured webhook secret, hex-encoded. Header name is configurable in the
 * Interakt dashboard; we use `x-interakt-signature`.
 */
export function verifyInteraktWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signatureHeader.trim());
}

/** Test/fixture helper: produce a valid signature for a body. */
export function signHmacSha256Hex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}
