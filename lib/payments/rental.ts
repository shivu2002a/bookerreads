import { and, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db/client";
import { events, loanPayments, loans } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { applyLoanEvent } from "@/lib/loans/persist";
import type { LoanError } from "@/lib/loans/types";
import type { RazorpayClient } from "./razorpay";

/**
 * Rental payments (design.md "Rental payment"). The loan machine owns the
 * state; this module owns the Razorpay order lifecycle around it:
 *
 *   createRentalOrder     borrower taps Pay → one order per loan (reused while open)
 *   recordRentalCapture   checkout callback or webhook → `pay` event, idempotent
 *   processPendingRefunds cron → Razorpay refund for loans expired after payment
 */

const SYSTEM = { kind: "system" as const };

export type RentalOrder = {
  orderId: string;
  amountPaise: number;
  loanId: string;
};

export type RentalOrderError =
  | "loan_not_found"
  | "not_borrower"
  | "not_payable"
  | "already_paid"
  | "window_closed";

export async function createRentalOrder(
  db: Db,
  razorpay: Pick<RazorpayClient, "createOrder">,
  input: { loanId: string; memberId: string },
  now = new Date(),
): Promise<{ ok: true; order: RentalOrder } | { ok: false; error: RentalOrderError }> {
  const [loan] = await db
    .select({
      id: loans.id,
      state: loans.state,
      borrowerId: loans.borrowerId,
      rentalPaise: loans.rentalPaise,
      paidAt: loans.paidAt,
      paymentDueAt: loans.paymentDueAt,
    })
    .from(loans)
    .where(eq(loans.id, input.loanId));
  if (!loan) return { ok: false, error: "loan_not_found" };
  if (loan.borrowerId !== input.memberId) return { ok: false, error: "not_borrower" };
  if (loan.paidAt) return { ok: false, error: "already_paid" };
  if (loan.state !== "accepted" || loan.rentalPaise <= 0) return { ok: false, error: "not_payable" };
  if (loan.paymentDueAt && loan.paymentDueAt <= now) return { ok: false, error: "window_closed" };

  // Reuse an open order: Razorpay orders stay payable, and a second order would
  // let a double-tap create two charges.
  const [open] = await db
    .select({ orderId: loanPayments.razorpayOrderId, amountPaise: loanPayments.amountPaise })
    .from(loanPayments)
    .where(and(eq(loanPayments.loanId, loan.id), eq(loanPayments.status, "created")));
  if (open && open.amountPaise === loan.rentalPaise) {
    return { ok: true, order: { orderId: open.orderId, amountPaise: open.amountPaise, loanId: loan.id } };
  }

  const order = await razorpay.createOrder({
    amountPaise: loan.rentalPaise,
    memberId: input.memberId,
    purpose: "rental",
    loanId: loan.id,
    receipt: `rental-${loan.id}`,
  });
  await db.insert(loanPayments).values({
    loanId: loan.id,
    borrowerId: input.memberId,
    razorpayOrderId: order.id,
    amountPaise: loan.rentalPaise,
    status: "created",
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true, order: { orderId: order.id, amountPaise: loan.rentalPaise, loanId: loan.id } };
}

/**
 * Applies `pay`. Called from both the verified checkout callback and the
 * `payment.captured` webhook, so a second call for the same loan returns
 * `already_paid`, which callers treat as success.
 */
export async function recordRentalCapture(
  db: Db,
  input: { loanId: string; razorpayPaymentId: string; amountPaise: number },
  config: AppConfig,
  now = new Date(),
): Promise<{ ok: true; duplicate: boolean } | { ok: false; error: LoanError }> {
  const res = await applyLoanEvent(
    db,
    input.loanId,
    { type: "pay", razorpayPaymentId: input.razorpayPaymentId, amountPaise: input.amountPaise },
    SYSTEM,
    config,
    { now: () => now },
  );
  if (res.ok) return { ok: true, duplicate: false };
  if (res.error.code === "already_paid") return { ok: true, duplicate: true };
  return { ok: false, error: res.error };
}

/** Which loan a captured payment belongs to, from the order we created for it. */
export async function loanIdForOrder(db: DbOrTx, razorpayOrderId: string): Promise<string | null> {
  const [row] = await db
    .select({ loanId: loanPayments.loanId })
    .from(loanPayments)
    .where(eq(loanPayments.razorpayOrderId, razorpayOrderId));
  return row?.loanId ?? null;
}

/**
 * Daily cron: issue Razorpay refunds for payments the machine flagged
 * (`refund_payment` effect). One API call per row; a failure leaves the row
 * pending for the next run and records the reason.
 */
export async function processPendingRefunds(
  db: Db,
  razorpay: Pick<RazorpayClient, "createRefund">,
  now = new Date(),
): Promise<{ refunded: number; failed: number }> {
  const pending = await db
    .select({
      id: loanPayments.id,
      loanId: loanPayments.loanId,
      borrowerId: loanPayments.borrowerId,
      razorpayPaymentId: loanPayments.razorpayPaymentId,
      amountPaise: loanPayments.amountPaise,
    })
    .from(loanPayments)
    .where(eq(loanPayments.status, "refund_pending"));

  let refunded = 0;
  let failed = 0;
  for (const p of pending) {
    if (!p.razorpayPaymentId) {
      failed++;
      continue;
    }
    try {
      const refund = await razorpay.createRefund({
        paymentId: p.razorpayPaymentId,
        amountPaise: p.amountPaise,
        memberId: p.borrowerId,
        purpose: "rental_refund",
        loanId: p.loanId,
      });
      await db
        .update(loanPayments)
        .set({ status: "refunded", razorpayRefundId: refund.id, refundedAt: now, updatedAt: now })
        .where(eq(loanPayments.id, p.id));
      await db.insert(events).values({
        aggregate: "loan",
        aggregateId: p.loanId,
        type: "payment.refunded",
        payload: { amountPaise: p.amountPaise, razorpayRefundId: refund.id },
        createdAt: now,
      });
      refunded++;
    } catch (err) {
      await db
        .update(loanPayments)
        .set({ failureReason: (err as Error).message, updatedAt: now })
        .where(eq(loanPayments.id, p.id));
      failed++;
    }
  }
  return { refunded, failed };
}

/** Rental earnings summary for a lender's dashboard (Requirement 10.5). */
export async function lenderEarningsSummary(
  db: DbOrTx,
  memberId: string,
  monthStart: Date,
): Promise<{ thisMonthPaise: number; thisMonthLoans: number; allTimePaise: number }> {
  const rows = await db
    .select({
      handedOffAt: loans.handedOffAt,
      rentalPaise: loans.rentalPaise,
      fee: loans.platformFeePaise,
    })
    .from(loans)
    .where(eq(loans.lenderId, memberId));
  let thisMonthPaise = 0;
  let thisMonthLoans = 0;
  let allTimePaise = 0;
  for (const r of rows) {
    if (!r.handedOffAt) continue;
    const share = r.rentalPaise - r.fee;
    allTimePaise += share;
    if (r.handedOffAt >= monthStart) {
      thisMonthPaise += share;
      thisMonthLoans++;
    }
  }
  return { thisMonthPaise, thisMonthLoans, allTimePaise };
}
