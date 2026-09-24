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
} from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { postEntry } from "@/lib/ledger/post";
import { evaluateActivation } from "./activation";

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
 * Sets the member to `active` once the deposit and the listing gate both hold
 * (design.md Activation). Idempotent; safe to call after any deposit payment or
 * copy creation. Suspended and cancelled members are left alone.
 */
export async function activateIfEligible(
  tx: DbOrTx,
  memberId: string,
  config: AppConfig,
  now = new Date(),
): Promise<boolean> {
  const [m] = await tx
    .select({ state: members.state })
    .from(members)
    .where(eq(members.id, memberId));
  if (!m || m.state !== "registered") return false;

  const status = await evaluateActivation(tx, memberId, config);
  if (!status.ok) return false;

  await tx.update(members).set({ state: "active" }).where(eq(members.id, memberId));
  await memberEvent(tx, memberId, "member.activated", {}, now);
  await queueNotification(tx, memberId, "membership_activated", {}, now);
  return true;
}

/** Member leaves: blocks new requests; the deposit refund follows Requirement 4.6. */
export async function cancelMember(tx: DbOrTx, memberId: string, now = new Date()) {
  await tx.update(members).set({ state: "cancelled" }).where(eq(members.id, memberId));
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
    .set({ deletedAt: now, state: "cancelled", displayName: null, upiId: null })
    .where(eq(members.id, memberId));
  await memberEvent(tx, memberId, "member.deleted", { forfeitedPaise: forfeited }, now);
  return { ok: true, forfeitedPaise: forfeited };
}
