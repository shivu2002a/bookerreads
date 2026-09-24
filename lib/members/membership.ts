import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import {
  copies,
  disputes,
  events,
  ledgerEntries,
  loans,
  members,
  notifications,
  plans,
  subscriptionPayments,
} from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { postEntry } from "@/lib/ledger/post";
import { evaluateActivation } from "./activation";

const startOfMonthUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

async function memberEvent(
  tx: DbOrTx,
  memberId: string,
  type: string,
  payload: Record<string, unknown> = {},
  now = new Date(),
) {
  await tx
    .insert(events)
    .values({ aggregate: "member", aggregateId: memberId, type, payload, createdAt: now });
}

async function queueNotification(
  tx: DbOrTx,
  memberId: string,
  template: string,
  payload: Record<string, string | number> = {},
  now = new Date(),
) {
  await tx
    .insert(notifications)
    .values({ memberId, template, channel: "whatsapp", payload, status: "queued", createdAt: now });
}

/**
 * Sets the member to `active` once plan, deposit, and borrow gate all hold
 * (design.md Activation step 4). Idempotent; safe to call after any money event.
 */
export async function activateIfEligible(
  tx: DbOrTx,
  memberId: string,
  config: AppConfig,
  now = new Date(),
): Promise<boolean> {
  const [m] = await tx
    .select({ state: members.state, planId: members.planId, deposit: members.depositBalancePaise })
    .from(members)
    .where(eq(members.id, memberId));
  if (!m || !m.planId || m.deposit < config.deposit_paise) return false;
  if (m.state === "active" || m.state === "suspended") return false;

  // Borrow gate must hold too; the plan and deposit checks in evaluateActivation
  // look at state, so evaluate with those two known-good and check the gate alone.
  const status = await evaluateActivation(tx, memberId, config);
  if (!status.checks.borrowGate.ok) return false;

  await tx
    .update(members)
    .set({ state: "active", subscriptionPendingSince: null })
    .where(eq(members.id, memberId));
  await memberEvent(tx, memberId, "member.activated", {}, now);
  await queueNotification(tx, memberId, "membership_activated", {}, now);
  return true;
}

/** subscription.activated / authenticated: attach the plan to the member. */
export async function attachSubscription(
  tx: DbOrTx,
  input: {
    memberId: string;
    razorpaySubscriptionId: string;
    razorpayPlanId: string;
    customerId?: string | null;
  },
  config: AppConfig,
  now = new Date(),
) {
  const [plan] = await tx
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.razorpayPlanId, input.razorpayPlanId));
  if (!plan) throw new Error(`No plan with razorpay_plan_id ${input.razorpayPlanId}`);
  await tx
    .update(members)
    .set({
      planId: plan.id,
      razorpaySubscriptionId: input.razorpaySubscriptionId,
      ...(input.customerId ? { razorpayCustomerId: input.customerId } : {}),
      subscriptionPendingSince: null,
    })
    .where(eq(members.id, input.memberId));
  await memberEvent(
    tx,
    input.memberId,
    "member.subscription_attached",
    { planId: plan.id, subscriptionId: input.razorpaySubscriptionId },
    now,
  );
  await activateIfEligible(tx, input.memberId, config, now);
}

/** subscription.charged: revenue row for the pool; a lapsed member who pays comes back. */
export async function recordSubscriptionCharge(
  tx: DbOrTx,
  input: {
    memberId: string;
    razorpayPaymentId: string;
    razorpaySubscriptionId: string;
    amountPaise: number;
    paidAt: Date;
  },
  config: AppConfig,
  now = new Date(),
) {
  const inserted = await tx
    .insert(subscriptionPayments)
    .values({
      memberId: input.memberId,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpaySubscriptionId: input.razorpaySubscriptionId,
      amountPaise: input.amountPaise,
      status: "captured",
      paidAt: input.paidAt,
      poolMonth: startOfMonthUtc(input.paidAt),
    })
    .onConflictDoNothing({ target: subscriptionPayments.razorpayPaymentId })
    .returning({ id: subscriptionPayments.id });
  if (!inserted.length) return { duplicate: true };

  const [m] = await tx
    .select({ state: members.state })
    .from(members)
    .where(eq(members.id, input.memberId));
  await tx
    .update(members)
    .set({ subscriptionPendingSince: null })
    .where(eq(members.id, input.memberId));
  if (m?.state === "lapsed") {
    await tx.update(members).set({ state: "registered" }).where(eq(members.id, input.memberId));
    await memberEvent(
      tx,
      input.memberId,
      "member.renewed",
      { paymentId: input.razorpayPaymentId },
      now,
    );
    await activateIfEligible(tx, input.memberId, config, now);
  }
  return { duplicate: false };
}

export async function recordSubscriptionFailure(
  tx: DbOrTx,
  input: {
    memberId: string;
    razorpayPaymentId: string;
    razorpaySubscriptionId: string;
    amountPaise: number;
    at: Date;
  },
  now = new Date(),
) {
  await tx
    .insert(subscriptionPayments)
    .values({
      memberId: input.memberId,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpaySubscriptionId: input.razorpaySubscriptionId,
      amountPaise: input.amountPaise,
      status: "failed",
      paidAt: input.at,
      poolMonth: startOfMonthUtc(input.at),
    })
    .onConflictDoNothing({ target: subscriptionPayments.razorpayPaymentId });
  await memberEvent(
    tx,
    input.memberId,
    "member.payment_failed",
    { paymentId: input.razorpayPaymentId },
    now,
  );
}

/** subscription.pending: Razorpay is retrying; start the 7-day clock (Requirement 4.5). */
export async function markSubscriptionPending(tx: DbOrTx, memberId: string, now = new Date()) {
  await tx
    .update(members)
    .set({ subscriptionPendingSince: now })
    .where(and(eq(members.id, memberId), sql`${members.subscriptionPendingSince} is null`));
  await queueNotification(tx, memberId, "payment_retrying", {}, now);
}

/** Blocks new requests, keeps existing loans (Requirement 4.5). */
export async function lapseMember(
  tx: DbOrTx,
  memberId: string,
  reason: "halted" | "pending_timeout",
  now = new Date(),
) {
  const [m] = await tx
    .select({ state: members.state })
    .from(members)
    .where(eq(members.id, memberId));
  if (!m || m.state !== "active") return false;
  await tx.update(members).set({ state: "lapsed" }).where(eq(members.id, memberId));
  await memberEvent(tx, memberId, "member.lapsed", { reason }, now);
  await queueNotification(tx, memberId, "membership_lapsed", {}, now);
  return true;
}

/** Members whose subscription has been pending longer than the config window. */
export async function findMembersToLapse(
  db: DbOrTx,
  config: AppConfig,
  now = new Date(),
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - config.subscription_pending_to_lapsed_days * 86_400_000);
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.state, "active"), sql`${members.subscriptionPendingSince} <= ${cutoff}`));
  return rows.map((r) => r.id);
}

/** subscription.cancelled (after cancel_at_cycle_end) or an admin cancellation. */
export async function cancelMember(tx: DbOrTx, memberId: string, now = new Date()) {
  await tx
    .update(members)
    .set({
      state: "cancelled",
      planId: null,
      razorpaySubscriptionId: null,
      subscriptionPendingSince: null,
    })
    .where(eq(members.id, memberId));
  await memberEvent(tx, memberId, "member.cancelled", {}, now);
  await queueNotification(tx, memberId, "membership_cancelled", {}, now);
}

/** payment.captured on a deposit or top-up order. */
export async function recordDepositPayment(
  tx: DbOrTx,
  input: {
    memberId: string;
    razorpayPaymentId: string;
    amountPaise: number;
    purpose: "deposit" | "topup";
  },
  config: AppConfig,
  now = new Date(),
): Promise<{ duplicate: boolean }> {
  // Checkout confirmation and the webhook may both report this payment; the payment id is the key.
  const [existing] = await tx
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.razorpayRef, input.razorpayPaymentId));
  if (existing) return { duplicate: true };
  await postEntry(tx, {
    memberId: input.memberId,
    account: "deposit",
    kind: input.purpose === "deposit" ? "deposit_in" : "deposit_topup",
    amountPaise: input.amountPaise,
    razorpayRef: input.razorpayPaymentId,
    createdAt: now,
  });
  await tx
    .update(members)
    .set({ needsTopup: false })
    .where(
      and(
        eq(members.id, input.memberId),
        sql`${members.depositBalancePaise} >= ${config.deposit_paise}`,
      ),
    );
  await memberEvent(
    tx,
    input.memberId,
    `member.${input.purpose}_paid`,
    { paymentId: input.razorpayPaymentId, amountPaise: input.amountPaise },
    now,
  );
  await activateIfEligible(tx, input.memberId, config, now);
  return { duplicate: false };
}

export type RefundEligibility =
  | { ok: true; amountPaise: number }
  | { ok: false; reason: "open_loans" | "open_dispute" | "nothing_to_refund" | "not_cancelled" };

/** Requirement 4.6: refund only when no open loans or disputes, after cancellation. */
export async function checkRefundEligibility(
  db: DbOrTx,
  memberId: string,
): Promise<RefundEligibility> {
  const [m] = await db
    .select({ state: members.state, deposit: members.depositBalancePaise })
    .from(members)
    .where(eq(members.id, memberId));
  if (!m) return { ok: false, reason: "nothing_to_refund" };
  if (m.state !== "cancelled" && m.state !== "registered")
    return { ok: false, reason: "not_cancelled" };
  if (m.deposit <= 0) return { ok: false, reason: "nothing_to_refund" };
  const [{ open }] = await db
    .select({ open: sql<number>`count(*)` })
    .from(loans)
    .where(
      and(
        sql`${loans.borrowerId} = ${memberId} or ${loans.lenderId} = ${memberId}`,
        inArray(loans.state, ["requested", "accepted", "on_loan", "overdue"]),
      ),
    );
  if (Number(open) > 0) return { ok: false, reason: "open_loans" };
  const [{ disputed }] = await db
    .select({ disputed: sql<number>`count(*)` })
    .from(disputes)
    .innerJoin(loans, eq(loans.id, disputes.loanId))
    .where(
      and(
        eq(disputes.state, "open"),
        sql`${loans.borrowerId} = ${memberId} or ${loans.lenderId} = ${memberId}`,
      ),
    );
  if (Number(disputed) > 0) return { ok: false, reason: "open_dispute" };
  return { ok: true, amountPaise: m.deposit };
}

/** refund.processed: deposit leaves the ledger. */
export async function recordDepositRefund(
  tx: DbOrTx,
  input: { memberId: string; razorpayRefundId: string; amountPaise: number },
  now = new Date(),
) {
  await postEntry(tx, {
    memberId: input.memberId,
    account: "deposit",
    kind: "deposit_refund",
    amountPaise: -input.amountPaise,
    razorpayRef: input.razorpayRefundId,
    createdAt: now,
  });
  await memberEvent(
    tx,
    input.memberId,
    "member.deposit_refunded",
    { refundId: input.razorpayRefundId, amountPaise: input.amountPaise },
    now,
  );
  await queueNotification(
    tx,
    input.memberId,
    "deposit_refunded",
    { amountPaise: input.amountPaise },
    now,
  );
}

/**
 * Requirement 10.7: deleting an account forfeits a payout balance below the
 * threshold (disclosed at signup). Soft delete; loans and ledger stay for audit.
 */
export async function deleteAccount(
  tx: DbOrTx,
  memberId: string,
  config: AppConfig,
  now = new Date(),
): Promise<
  { ok: true; forfeitedPaise: number } | { ok: false; reason: "open_loans" | "has_deposit" }
> {
  const [{ open }] = await tx
    .select({ open: sql<number>`count(*)` })
    .from(loans)
    .where(
      and(
        sql`${loans.borrowerId} = ${memberId} or ${loans.lenderId} = ${memberId}`,
        inArray(loans.state, ["requested", "accepted", "on_loan", "overdue", "disputed"]),
      ),
    );
  if (Number(open) > 0) return { ok: false, reason: "open_loans" };
  const [m] = await tx
    .select({ deposit: members.depositBalancePaise, payout: members.payoutBalancePaise })
    .from(members)
    .where(eq(members.id, memberId));
  if (m.deposit > 0) return { ok: false, reason: "has_deposit" };

  let forfeited = 0;
  if (m.payout > 0 && m.payout < config.payout_threshold_paise) {
    await postEntry(tx, {
      memberId,
      account: "payout",
      kind: "adjustment",
      amountPaise: -m.payout,
      note: "Forfeited on account deletion (below payout threshold)",
      createdAt: now,
    });
    forfeited = m.payout;
  }
  await tx
    .update(copies)
    .set({ availability: "unlisted", lastActivityAt: now })
    .where(and(eq(copies.ownerId, memberId), eq(copies.availability, "available")));
  await tx
    .update(members)
    .set({ deletedAt: now, state: "cancelled", displayName: null, upiId: null, planId: null })
    .where(eq(members.id, memberId));
  await memberEvent(tx, memberId, "member.deleted", { forfeitedPaise: forfeited }, now);
  return { ok: true, forfeitedPaise: forfeited };
}
