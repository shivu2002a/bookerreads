import { date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { baseColumns, timestamptz } from "./_shared";
import { ledgerAccount, ledgerKind, loanPaymentStatus, payoutStatus } from "./enums";
import { loans } from "./loans";
import { members } from "./members";

/** One row per monthly payout to a lender (Requirement 10.3–10.4). */
export const payouts = pgTable(
  "payouts",
  {
    ...baseColumns,
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    /** First day of the month the batch covers. */
    month: date("month", { mode: "date" }).notNull(),
    amountPaise: integer("amount_paise").notNull(),
    upiId: text("upi_id").notNull(),
    status: payoutStatus("status").notNull().default("pending"),
    razorpayPayoutId: text("razorpay_payout_id"),
    batchId: text("batch_id").notNull(),
    failureReason: text("failure_reason"),
  },
  (t) => [
    index("payouts_batch_idx").on(t.batchId),
    index("payouts_member_idx").on(t.memberId),
    // One payout per member per month keeps batch generation idempotent.
    uniqueIndex("payouts_member_month_uidx").on(t.memberId, t.month),
  ],
);

/**
 * Append-only. Every rupee movement is a row. `members.*_balance_paise`
 * are cached sums recomputed in the same transaction as each insert.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    ...baseColumns,
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    account: ledgerAccount("account").notNull(),
    kind: ledgerKind("kind").notNull(),
    /** Signed. Positive increases the balance. */
    amountPaise: integer("amount_paise").notNull(),
    loanId: uuid("loan_id").references(() => loans.id),
    payoutId: uuid("payout_id").references(() => payouts.id),
    razorpayRef: text("razorpay_ref"),
    note: text("note"),
    /** Admin who made an adjustment; null for system entries. */
    actorId: uuid("actor_id").references(() => members.id),
  },
  (t) => [
    index("ledger_member_account_idx").on(t.memberId, t.account),
    index("ledger_loan_idx").on(t.loanId),
  ],
);

/**
 * One row per Razorpay order raised for a loan's rental price (Requirement 5).
 * `refund_pending` is set by the loan machine's `refund_payment` effect and
 * drained by the daily cron, which calls Razorpay and marks `refunded`.
 */
export const loanPayments = pgTable(
  "loan_payments",
  {
    ...baseColumns,
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id),
    borrowerId: uuid("borrower_id")
      .notNull()
      .references(() => members.id),
    razorpayOrderId: text("razorpay_order_id").notNull().unique(),
    razorpayPaymentId: text("razorpay_payment_id").unique(),
    amountPaise: integer("amount_paise").notNull(),
    status: loanPaymentStatus("status").notNull().default("created"),
    paidAt: timestamptz("paid_at"),
    razorpayRefundId: text("razorpay_refund_id"),
    refundedAt: timestamptz("refunded_at"),
    failureReason: text("failure_reason"),
  },
  (t) => [
    index("loan_payments_loan_idx").on(t.loanId),
    index("loan_payments_status_idx").on(t.status),
  ],
);

/** Provider webhook idempotency (Requirement 15.3). */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    ...baseColumns,
    provider: text("provider").notNull(), // razorpay | interakt
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamptz("processed_at"),
    error: text("error"),
  },
  (t) => [uniqueIndex("webhook_events_provider_event_uidx").on(t.provider, t.providerEventId)],
);
