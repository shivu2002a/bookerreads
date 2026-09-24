"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { members, plans } from "@/db/schema";
import { err, ok, type ActionResult } from "@/lib/actions/result";
import { track } from "@/lib/analytics/server";
import { getAuthUser, requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { getServerEnv } from "@/lib/env";
import { evaluateActivation, type ActivationStatus } from "@/lib/members/activation";
import { attachSubscription, recordDepositPayment } from "@/lib/members/membership";
import { getRazorpay, RazorpayError } from "@/lib/payments/razorpay";
import { verifyRazorpayCheckoutSignature } from "@/lib/security/webhook-signature";
import { flushNotifications } from "@/lib/notify";

export type CheckoutHandle = {
  keyId: string;
  /** Either an order (deposit/top-up) or a subscription. */
  orderId?: string;
  subscriptionId?: string;
  amountPaise: number;
  description: string;
};

async function ensureCustomer(memberId: string, existing: string | null): Promise<string> {
  if (existing) return existing;
  const user = await getAuthUser();
  const contact = user?.phone ? `+${user.phone.replace(/^\+/, "")}` : "";
  const customer = await getRazorpay().createCustomer({ memberId, contact });
  await getDb()
    .update(members)
    .set({ razorpayCustomerId: customer.id })
    .where(eq(members.id, memberId));
  return customer.id;
}

function paymentError(e: unknown, fallback: string): ActionResult<never> {
  if (e instanceof RazorpayError)
    console.error("razorpay", { status: e.status, code: e.code, message: e.message });
  else console.error("payment action failed", e);
  return err("payment_provider", fallback);
}

/** Creates the Razorpay subscription for a plan and returns what Checkout needs. */
export async function startSubscription(planCode: string): Promise<ActionResult<CheckoutHandle>> {
  const member = await requireOnboardedMember();
  const code = z.enum(["reader", "regular", "heavy"]).safeParse(planCode);
  if (!code.success) return err("invalid_plan", "Pick a plan.");
  if (member.state === "active" && member.planId)
    return err("already_active", "You already have an active plan.");
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.code, code.data));
  if (!plan?.active || !plan.razorpayPlanId)
    return err("plan_unavailable", "That plan isn't available right now.");

  try {
    const customerId = await ensureCustomer(member.id, member.razorpayCustomerId);
    const sub = await getRazorpay().createSubscription({
      planId: plan.razorpayPlanId,
      customerId,
      memberId: member.id,
      planCode: plan.code,
    });
    await db
      .update(members)
      .set({ razorpaySubscriptionId: sub.id })
      .where(eq(members.id, member.id));
    return ok({
      keyId: getServerEnv().RAZORPAY_KEY_ID,
      subscriptionId: sub.id,
      amountPaise: plan.pricePaise,
      description: `${plan.name} plan, monthly`,
    });
  } catch (e) {
    return paymentError(e, "Couldn't start the subscription. Please try again in a moment.");
  }
}

/** Deposit order for the full amount, or a top-up order for the shortfall. */
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
  razorpay_order_id: z.string().optional(),
  razorpay_subscription_id: z.string().optional(),
  razorpay_signature: z.string().min(1),
});

/**
 * Called by the client when Checkout reports success. Verifies the signature,
 * then records the result directly so the member does not wait for the
 * webhook. Both paths are idempotent on the payment id.
 */
export async function confirmCheckout(
  input: z.input<typeof checkoutSchema>,
): Promise<ActionResult<ActivationStatus>> {
  const member = await requireOnboardedMember();
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) return err("invalid", "Payment details were incomplete.");
  const {
    razorpay_payment_id: paymentId,
    razorpay_order_id: orderId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: signature,
  } = parsed.data;
  const secret = getServerEnv().RAZORPAY_KEY_SECRET;

  const parts: [string, string] | null = orderId
    ? [orderId, paymentId]
    : subscriptionId
      ? [paymentId, subscriptionId]
      : null;
  if (!parts || !verifyRazorpayCheckoutSignature(parts, signature, secret))
    return err(
      "bad_signature",
      "We couldn't verify that payment. If money was taken, it will be reflected within a few minutes.",
    );

  const db = getDb();
  const config = await loadConfig(db);
  try {
    const rz = getRazorpay();
    if (orderId) {
      const payment = await rz.fetchPayment(paymentId);
      if (payment.status !== "captured" && payment.status !== "authorized")
        return err("not_captured", "The payment hasn't completed yet.");
      const purpose = payment.notes?.purpose === "topup" ? "topup" : "deposit";
      if (payment.notes?.member_id && payment.notes.member_id !== member.id)
        return err("mismatch", "That payment belongs to a different account.");
      await db.transaction((tx) =>
        recordDepositPayment(
          tx,
          {
            memberId: member.id,
            razorpayPaymentId: paymentId,
            amountPaise: payment.amount,
            purpose,
          },
          config,
        ),
      );
    } else if (subscriptionId) {
      const sub = await rz.fetchSubscription(subscriptionId);
      if (sub.notes?.member_id && sub.notes.member_id !== member.id)
        return err("mismatch", "That subscription belongs to a different account.");
      await db.transaction((tx) =>
        attachSubscription(
          tx,
          {
            memberId: member.id,
            razorpaySubscriptionId: sub.id,
            razorpayPlanId: sub.plan_id,
            customerId: sub.customer_id ?? null,
          },
          config,
        ),
      );
    }
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
