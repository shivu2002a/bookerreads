import {
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns, timestamptz } from "./_shared";
import { clusters } from "./clusters";
import { memberState } from "./enums";
import { plans } from "./plans";

export const members = pgTable(
  "members",
  {
    ...baseColumns,
    /** Supabase auth.users.id. The raw phone number lives only in Supabase Auth. */
    authUserId: uuid("auth_user_id").notNull().unique(),
    /** sha256 of the E.164 phone. Lets admins look a member up by phone without storing it. */
    phoneHash: text("phone_hash").notNull().unique(),
    displayName: text("display_name"),
    clusterId: uuid("cluster_id").references(() => clusters.id),
    state: memberState("state").notNull().default("registered"),
    suspendedUntil: timestamptz("suspended_until"),
    planId: uuid("plan_id").references(() => plans.id),
    razorpayCustomerId: text("razorpay_customer_id"),
    razorpaySubscriptionId: text("razorpay_subscription_id"),
    /** Set when Razorpay reports the subscription pending; cleared on charge. Drives lapse after 7 days. */
    subscriptionPendingSince: timestamptz("subscription_pending_since"),
    /** Cached sums of ledger_entries; recomputed in the same transaction as each entry. */
    depositBalancePaise: integer("deposit_balance_paise").notNull().default(0),
    payoutBalancePaise: integer("payout_balance_paise").notNull().default(0),
    needsTopup: boolean("needs_topup").notNull().default(false),
    upiId: text("upi_id"),
    upiVerified: boolean("upi_verified").notNull().default(false),
    /** Denormalised; recomputed from trust_events on every event. */
    trustScore: smallint("trust_score").notNull().default(50),
    /** Set only via SQL. Never exposed to a client-side mutation. */
    isAdmin: boolean("is_admin").notNull().default(false),
    /** First loan completed as borrower; drives the one-at-a-time rule for new borrowers. */
    firstBorrowCompletedAt: timestamptz("first_borrow_completed_at"),
    termsAcceptedAt: timestamptz("terms_accepted_at"),
    /** Soft delete; balances below the payout threshold are forfeited at this point (Requirement 10.7). */
    deletedAt: timestamptz("deleted_at"),
  },
  (t) => [
    index("members_cluster_state_idx").on(t.clusterId, t.state),
    index("members_display_name_idx").on(t.displayName),
  ],
);

/** Members who asked to join a cluster that is not yet open (Requirement 1.3). */
export const clusterWaitlist = pgTable(
  "cluster_waitlist",
  {
    ...baseColumns,
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    pincode: text("pincode"),
    notifiedAt: timestamptz("notified_at"),
  },
  (t) => [uniqueIndex("cluster_waitlist_member_uidx").on(t.clusterId, t.memberId)],
);

/** Application-level OTP rate limiting by IP (Requirement 15.5). Rows expire by cron. */
export const otpAttempts = pgTable(
  "otp_attempts",
  {
    ...baseColumns,
    ipHash: text("ip_hash").notNull(),
    phoneHash: text("phone_hash").notNull(),
  },
  (t) => [
    index("otp_attempts_ip_created_idx").on(t.ipHash, t.createdAt),
    index("otp_attempts_phone_created_idx").on(t.phoneHash, t.createdAt),
  ],
);
