import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns, timestamptz } from "./_shared";
import { ledgerAccount, ledgerKind, paymentStatus, payoutStatus } from "./enums";
import { loans } from "./loans";
import { members } from "./members";

/** Immutable record of each monthly pool computation (Requirement 10.3). */
export const poolRuns = pgTable("pool_runs", {
  ...baseColumns,
  /** First day of the month. Unique makes the run idempotent. */
  month: date("month", { mode: "date" }).notNull().unique(),
  revenuePaise: integer("revenue_paise").notNull(),
  poolPct: smallint("pool_pct").notNull(),
  poolPaise: integer("pool_paise").notNull(),
  carryInPaise: integer("carry_in_paise").notNull(),
  loanCount: integer("loan_count").notNull(),
  perLoanPaise: integer("per_loan_paise").notNull(),
  carryOutPaise: integer("carry_out_paise").notNull(),
  /** Frozen detail: per-lender loan counts and credits. */
  statement: jsonb("statement").$type<PoolStatement>().notNull(),
});

export type PoolStatement = {
  month: string;
  revenuePaise: number;
  poolPct: number;
  carryInPaise: number;
  poolPaise: number;
  loanCount: number;
  perLoanPaise: number;
  carryOutPaise: number;
  lenders: Array<{ memberId: string; loanCount: number; creditPaise: number }>;
};

export const payouts = pgTable(
  "payouts",
  {
    ...baseColumns,
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    poolRunId: uuid("pool_run_id")
      .notNull()
      .references(() => poolRuns.id),
    amountPaise: integer("amount_paise").notNull(),
    upiId: text("upi_id").notNull(),
    status: payoutStatus("status").notNull().default("pending"),
    razorpayPayoutId: text("razorpay_payout_id"),
    batchId: text("batch_id").notNull(),
    failureReason: text("failure_reason"),
  },
  (t) => [index("payouts_batch_idx").on(t.batchId), index("payouts_member_idx").on(t.memberId)],
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
    poolRunId: uuid("pool_run_id").references(() => poolRuns.id),
    payoutId: uuid("payout_id").references(() => payouts.id),
    razorpayRef: text("razorpay_ref"),
    note: text("note"),
    /** Admin who made an adjustment; null for system entries. */
    actorId: uuid("actor_id").references(() => members.id),
  },
  (t) => [
    index("ledger_member_account_idx").on(t.memberId, t.account),
    index("ledger_loan_idx").on(t.loanId),
    index("ledger_pool_run_idx").on(t.poolRunId),
  ],
);

export const subscriptionPayments = pgTable(
  "subscription_payments",
  {
    ...baseColumns,
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    razorpayPaymentId: text("razorpay_payment_id").notNull().unique(),
    razorpaySubscriptionId: text("razorpay_subscription_id").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    status: paymentStatus("status").notNull(),
    paidAt: timestamptz("paid_at").notNull(),
    /** First day of the month this payment's revenue counts toward. */
    poolMonth: date("pool_month", { mode: "date" }).notNull(),
  },
  (t) => [
    index("subscription_payments_pool_month_status_idx").on(t.poolMonth, t.status),
    index("subscription_payments_member_idx").on(t.memberId),
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
