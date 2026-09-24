import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { members, webhookEvents } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import {
  attachSubscription,
  cancelMember,
  lapseMember,
  markSubscriptionPending,
  recordDepositPayment,
  recordDepositRefund,
  recordSubscriptionCharge,
  recordSubscriptionFailure,
} from "@/lib/members/membership";

/** Razorpay webhook envelope (the parts we read). */
export type RazorpayWebhook = {
  event: string;
  created_at: number;
  payload: {
    subscription?: {
      entity: {
        id: string;
        plan_id: string;
        customer_id?: string;
        status: string;
        notes?: Record<string, string>;
      };
    };
    payment?: {
      entity: {
        id: string;
        amount: number;
        status: string;
        order_id?: string | null;
        notes?: Record<string, string>;
        created_at: number;
      };
    };
    order?: { entity: { id: string; notes?: Record<string, string> } };
    refund?: {
      entity: {
        id: string;
        payment_id: string;
        amount: number;
        status: string;
        notes?: Record<string, string>;
      };
    };
  };
};

export type WebhookOutcome =
  | { status: "processed"; event: string; memberId: string | null }
  | { status: "duplicate"; event: string }
  | { status: "ignored"; event: string; reason: string };

export const HANDLED_EVENTS = [
  "subscription.authenticated",
  "subscription.activated",
  "subscription.charged",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
  "subscription.completed",
  "payment.captured",
  "payment.failed",
  "refund.processed",
] as const;

/** Stable id for dedupe: Razorpay's event id header when present, else a body hash. */
export function webhookEventId(headerId: string | null, rawBody: string): string {
  return headerId?.trim() || `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
}

async function memberIdFromNotes(
  db: Db,
  notes: Record<string, string> | undefined,
  fallbackSubscriptionId?: string,
): Promise<string | null> {
  if (notes?.member_id) return notes.member_id;
  if (fallbackSubscriptionId) {
    const [m] = await db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.razorpaySubscriptionId, fallbackSubscriptionId));
    return m?.id ?? null;
  }
  return null;
}

/**
 * Requirement 15.3: each webhook is recorded once by (provider, event id) and
 * processed in a transaction. A repeat delivery returns `duplicate` without
 * side effects. Unknown or irrelevant events are recorded and ignored.
 */
export async function processRazorpayWebhook(
  db: Db,
  input: { eventId: string; body: RazorpayWebhook; rawBody: string },
  config: AppConfig,
  now = new Date(),
): Promise<WebhookOutcome> {
  const event = input.body.event;

  const inserted = await db
    .insert(webhookEvents)
    .values({
      provider: "razorpay",
      providerEventId: input.eventId,
      eventType: event,
      payload: input.body as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
    .returning({ id: webhookEvents.id });
  if (!inserted.length) return { status: "duplicate", event };
  const rowId = inserted[0].id;

  const finish = async (outcome: WebhookOutcome, error?: string) => {
    await db
      .update(webhookEvents)
      .set({ processedAt: now, error: error ?? null })
      .where(eq(webhookEvents.id, rowId));
    return outcome;
  };

  try {
    const outcome = await db.transaction(async (tx) =>
      handle(tx as unknown as Db, input.body, config, now),
    );
    return finish(outcome);
  } catch (err) {
    await finish({ status: "ignored", event, reason: "error" }, (err as Error).message);
    throw err;
  }
}

async function handle(
  tx: Db,
  body: RazorpayWebhook,
  config: AppConfig,
  now: Date,
): Promise<WebhookOutcome> {
  const event = body.event;
  const sub = body.payload.subscription?.entity;
  const pay = body.payload.payment?.entity;

  switch (event) {
    case "subscription.authenticated":
    case "subscription.activated": {
      if (!sub) return { status: "ignored", event, reason: "no subscription entity" };
      const memberId = await memberIdFromNotes(tx, sub.notes, sub.id);
      if (!memberId) return { status: "ignored", event, reason: "no member" };
      await attachSubscription(
        tx,
        {
          memberId,
          razorpaySubscriptionId: sub.id,
          razorpayPlanId: sub.plan_id,
          customerId: sub.customer_id ?? null,
        },
        config,
        now,
      );
      return { status: "processed", event, memberId };
    }
    case "subscription.charged": {
      if (!sub || !pay) return { status: "ignored", event, reason: "missing entity" };
      const memberId = await memberIdFromNotes(tx, sub.notes, sub.id);
      if (!memberId) return { status: "ignored", event, reason: "no member" };
      await recordSubscriptionCharge(
        tx,
        {
          memberId,
          razorpayPaymentId: pay.id,
          razorpaySubscriptionId: sub.id,
          amountPaise: pay.amount,
          paidAt: new Date(pay.created_at * 1000),
        },
        config,
        now,
      );
      return { status: "processed", event, memberId };
    }
    case "subscription.pending": {
      if (!sub) return { status: "ignored", event, reason: "no subscription entity" };
      const memberId = await memberIdFromNotes(tx, sub.notes, sub.id);
      if (!memberId) return { status: "ignored", event, reason: "no member" };
      await markSubscriptionPending(tx, memberId, now);
      if (pay)
        await recordSubscriptionFailure(
          tx,
          {
            memberId,
            razorpayPaymentId: pay.id,
            razorpaySubscriptionId: sub.id,
            amountPaise: pay.amount,
            at: new Date(pay.created_at * 1000),
          },
          now,
        );
      return { status: "processed", event, memberId };
    }
    case "subscription.halted": {
      if (!sub) return { status: "ignored", event, reason: "no subscription entity" };
      const memberId = await memberIdFromNotes(tx, sub.notes, sub.id);
      if (!memberId) return { status: "ignored", event, reason: "no member" };
      await lapseMember(tx, memberId, "halted", now);
      return { status: "processed", event, memberId };
    }
    case "subscription.cancelled":
    case "subscription.completed": {
      if (!sub) return { status: "ignored", event, reason: "no subscription entity" };
      const memberId = await memberIdFromNotes(tx, sub.notes, sub.id);
      if (!memberId) return { status: "ignored", event, reason: "no member" };
      await cancelMember(tx, memberId, now);
      return { status: "processed", event, memberId };
    }
    case "payment.captured": {
      if (!pay) return { status: "ignored", event, reason: "no payment entity" };
      const purpose = pay.notes?.purpose ?? body.payload.order?.entity.notes?.purpose;
      if (purpose !== "deposit" && purpose !== "topup")
        return { status: "ignored", event, reason: "not a deposit payment" };
      const memberId = pay.notes?.member_id ?? body.payload.order?.entity.notes?.member_id ?? null;
      if (!memberId) return { status: "ignored", event, reason: "no member" };
      await recordDepositPayment(
        tx,
        { memberId, razorpayPaymentId: pay.id, amountPaise: pay.amount, purpose },
        config,
        now,
      );
      return { status: "processed", event, memberId };
    }
    case "payment.failed":
      return { status: "ignored", event, reason: "recorded only" };
    case "refund.processed": {
      const refund = body.payload.refund?.entity;
      if (!refund) return { status: "ignored", event, reason: "no refund entity" };
      if (refund.notes?.purpose !== "deposit_refund" || !refund.notes.member_id)
        return { status: "ignored", event, reason: "not a deposit refund" };
      await recordDepositRefund(
        tx,
        {
          memberId: refund.notes.member_id,
          razorpayRefundId: refund.id,
          amountPaise: refund.amount,
        },
        now,
      );
      return { status: "processed", event, memberId: refund.notes.member_id };
    }
    default:
      return { status: "ignored", event, reason: "unhandled event" };
  }
}
