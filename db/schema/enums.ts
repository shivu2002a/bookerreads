import { pgEnum } from "drizzle-orm/pg-core";

export const clusterStatus = pgEnum("cluster_status", ["waitlist", "open", "paused"]);

export const memberState = pgEnum("member_state", [
  "registered",
  "active",
  "lapsed",
  "suspended",
  "cancelled",
]);

export const bookSource = pgEnum("book_source", ["google_books", "open_library", "manual"]);

export const copyCondition = pgEnum("copy_condition", ["like_new", "good", "worn"]);

export const handoffMethod = pgEnum("handoff_method", ["meetup", "drop_point", "courier"]);

export const copyAvailability = pgEnum("copy_availability", [
  "available",
  "requested",
  "on_loan",
  "unlisted",
  "lost",
]);

export const verificationStatus = pgEnum("verification_status", ["unverified", "verified"]);

export const loanState = pgEnum("loan_state", [
  "requested",
  "declined",
  "expired",
  "accepted",
  "on_loan",
  "overdue",
  "returned",
  "lost",
  "disputed",
  "resolved",
]);

export const loanParty = pgEnum("loan_party", ["lender", "borrower"]);

export const declineReason = pgEnum("decline_reason", ["not_available", "no_longer_have", "other"]);

export const loanPhase = pgEnum("loan_phase", ["out", "return"]);

export const disputeState = pgEnum("dispute_state", ["open", "resolved"]);

export const disputeResolution = pgEnum("dispute_resolution", [
  "dismissed",
  "partial_charge",
  "full_charge",
]);

export const ledgerAccount = pgEnum("ledger_account", ["deposit", "payout"]);

export const ledgerKind = pgEnum("ledger_kind", [
  "deposit_in",
  "deposit_refund",
  "deposit_charge",
  "deposit_topup",
  "pool_credit",
  "lost_book_credit",
  "payout_out",
  "adjustment",
]);

export const paymentStatus = pgEnum("payment_status", ["captured", "failed", "refunded"]);

export const payoutStatus = pgEnum("payout_status", ["pending", "exported", "paid", "failed"]);

export const trustEventKind = pgEnum("trust_event_kind", [
  "return_on_time",
  "return_late",
  "book_lost",
  "dispute_lost",
  "no_show",
  "request_ignored",
  "lend_completed",
  "borrow_completed",
]);

export const notificationChannel = pgEnum("notification_channel", ["whatsapp", "sms"]);

export const notificationStatus = pgEnum("notification_status", [
  "queued",
  "sent",
  "delivered",
  "failed",
]);

export const eventAggregate = pgEnum("event_aggregate", [
  "member",
  "copy",
  "loan",
  "dispute",
  "pool_run",
]);

export const cronJob = pgEnum("cron_job", ["daily", "monthly"]);
