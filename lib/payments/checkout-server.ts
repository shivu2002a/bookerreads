import "server-only";
import { err, ok, type ActionResult } from "@/lib/actions/result";
import { getServerEnv } from "@/lib/env";
import { verifyRazorpayCheckoutSignature } from "@/lib/security/webhook-signature";
import { getRazorpay, RazorpayError, type RazorpayPayment } from "./razorpay";

/** Shared by the deposit and rental checkout callbacks. */

export function paymentError(e: unknown, fallback: string): ActionResult<never> {
  if (e instanceof RazorpayError)
    console.error("razorpay", { status: e.status, code: e.code, message: e.message });
  else console.error("payment action failed", e);
  return err("payment_provider", fallback);
}

export type VerifiedCheckout = {
  payment: RazorpayPayment;
  paymentId: string;
  orderId: string;
};

/**
 * Verifies the Checkout success payload: HMAC over `order_id|payment_id`,
 * then the payment itself (captured or authorized) and that it was raised for
 * this member. Does not record anything.
 */
export async function verifyCheckout(
  input: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string },
  memberId: string,
): Promise<ActionResult<VerifiedCheckout>> {
  const {
    razorpay_payment_id: paymentId,
    razorpay_order_id: orderId,
    razorpay_signature: signature,
  } = input;
  const secret = getServerEnv().RAZORPAY_KEY_SECRET;
  if (!verifyRazorpayCheckoutSignature([orderId, paymentId], signature, secret))
    return err(
      "bad_signature",
      "We couldn't verify that payment. If money was taken, it will be reflected within a few minutes.",
    );
  try {
    const payment = await getRazorpay().fetchPayment(paymentId);
    if (payment.status !== "captured" && payment.status !== "authorized")
      return err("not_captured", "The payment hasn't completed yet.");
    if (payment.order_id && payment.order_id !== orderId)
      return err("mismatch", "That payment doesn't match the order.");
    if (payment.notes?.member_id && payment.notes.member_id !== memberId)
      return err("mismatch", "That payment belongs to a different account.");
    return ok({ payment, paymentId, orderId });
  } catch (e) {
    return paymentError(e, "Couldn't check the payment with Razorpay. Please try again.");
  }
}
