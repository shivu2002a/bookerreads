"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { err, ok, type ActionResult } from "@/lib/actions/result";
import { track } from "@/lib/analytics/server";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { getServerEnv } from "@/lib/env";
import { evaluateActivation, type ActivationStatus } from "@/lib/members/activation";
import { recordDepositPayment } from "@/lib/members/membership";
import { getRazorpay } from "@/lib/payments/razorpay";
import { paymentError, verifyCheckout } from "@/lib/payments/checkout-server";
import { flushNotifications } from "@/lib/notify";

export type CheckoutHandle = {
  keyId: string;
  orderId: string;
  amountPaise: number;
  description: string;
};

/** Deposit order for the full amount, or a top-up order for the shortfall (Requirement 4.3). */
export async function createDepositOrder(): Promise<ActionResult<CheckoutHandle>> {
  const member = await requireOnboardedMember();
  const db = getDb();
  const config = await loadConfig(db);
  const due = config.deposit_paise - member.depositBalancePaise;
  if (due <= 0) return err("deposit_held", "Your deposit is already in place.");
  const purpose = member.depositBalancePaise > 0 ? "topup" : "deposit";
  try {
    const order = await getRazorpay().createOrder({
      amountPaise: due,
      memberId: member.id,
      purpose,
      receipt: `${purpose}-${member.id.slice(0, 8)}-${Date.now()}`,
    });
    return ok({
      keyId: getServerEnv().RAZORPAY_KEY_ID,
      orderId: order.id,
      amountPaise: due,
      description: purpose === "deposit" ? "Refundable deposit" : "Deposit top-up",
    });
  } catch (e) {
    return paymentError(e, "Couldn't create the payment. Please try again in a moment.");
  }
}

const checkoutSchema = z.object({
  razorpay_payment_id: z.string().min(1),
  razorpay_order_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

/**
 * Called by the client when Checkout reports success. Verifies the signature,
 * then records the deposit directly so the member does not wait for the
 * webhook. Both paths are idempotent on the payment id.
 */
export async function confirmCheckout(
  input: z.input<typeof checkoutSchema>,
): Promise<ActionResult<ActivationStatus>> {
  const member = await requireOnboardedMember();
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) return err("invalid", "Payment details were incomplete.");

  const verified = await verifyCheckout(parsed.data, member.id);
  if (!verified.ok) return verified;
  const { payment, paymentId } = verified.data;
  if (payment.notes?.purpose !== "deposit" && payment.notes?.purpose !== "topup")
    return err("mismatch", "That payment isn't a deposit.");

  const db = getDb();
  const config = await loadConfig(db);
  try {
    await db.transaction((tx) =>
      recordDepositPayment(
        tx,
        {
          memberId: member.id,
          razorpayPaymentId: paymentId,
          amountPaise: payment.amount,
          purpose: payment.notes?.purpose === "topup" ? "topup" : "deposit",
        },
        config,
      ),
    );
  } catch (e) {
    return paymentError(
      e,
      "Payment received, but we couldn't update your account yet. It will sync automatically.",
    );
  }

  const status = await evaluateActivation(db, member.id, config);
  if (status.ok) track(member.id, "member_activated");
  await flushNotifications();
  revalidatePath("/activate");
  return ok(status);
}

export async function getActivationStatus(): Promise<ActionResult<ActivationStatus>> {
  const member = await requireOnboardedMember();
  const db = getDb();
  return ok(await evaluateActivation(db, member.id, await loadConfig(db)));
}
