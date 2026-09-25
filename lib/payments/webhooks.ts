import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { loanPayments, webhookEvents } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { recordDepositPayment, recordDepositRefund } from "@/lib/members/membership";
import { loanIdForOrder, recordRentalCapture } from "./rental";

/** Razorpay webhook envelope (the parts we read). */
export type RazorpayWebhook = {
  event: string;
  created_at: number;
  payload: {
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

export const HANDLED_EVENTS = ["payment.captured", "payment.failed", "refund.processed"] as const;

/** Stable id for dedupe: Razorpay's event id header when present, else a body hash. */
export function webhookEventId(headerId: string | null, rawBody: string): string {
  return headerId?.trim() || `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
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
  const pay = body.payload.payment?.entity;

  switch (event) {
    case "payment.captured": {
      if (!pay) return { status: "ignored", event, reason: "no payment entity" };
      const notes = { ...body.payload.order?.entity.notes, ...pay.notes };
      const purpose = notes.purpose;
      const memberId = notes.member_id ?? null;
      if (purpose === "rental") {
        // Route by our own order row first; the note is a fallback for orders created elsewhere.
        const loanId =
          (pay.order_id ? await loanIdForOrder(tx, pay.order_id) : null) ?? notes.loan_id ?? null;
        if (!loanId) return { status: "ignored", event, reason: "rental without loan" };
        const res = await recordRentalCapture(
          tx,
          { loanId, razorpayPaymentId: pay.id, amountPaise: pay.amount },
          config,
          now,
        );
        if (!res.ok) return { status: "ignored", event, reason: res.error.code };
        return { status: "processed", event, memberId };
      }
      if (purpose !== "deposit" && purpose !== "topup")
        return { status: "ignored", event, reason: "not a deposit payment" };
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
      if (refund.notes?.purpose === "rental_refund") {
        // The cron already marked the row when it created the refund; this confirms settlement.
        await tx
          .update(loanPayments)
          .set({ status: "refunded", razorpayRefundId: refund.id, refundedAt: now, updatedAt: now })
          .where(eq(loanPayments.razorpayPaymentId, refund.payment_id));
        return { status: "processed", event, memberId: refund.notes.member_id ?? null };
      }
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
