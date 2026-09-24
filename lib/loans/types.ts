/**
 * Types for the loan state machine. Pure data; no database or React imports.
 */

export const LOAN_STATES = [
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
] as const;
export type LoanState = (typeof LOAN_STATES)[number];

export type Party = "lender" | "borrower";
/**
 * `meetup` and `courier` (a Porter rider booked by the members) both confirm
 * with photos on each side. `drop_point` is retained for historical loans only;
 * new copies no longer offer it.
 */
export type HandoffMethod = "meetup" | "drop_point" | "courier";
export type CopyCondition = "like_new" | "good" | "worn";
export type DeclineReason = "not_available" | "no_longer_have" | "other";
export type DisputeResolution = "dismissed" | "partial_charge" | "full_charge";

/** The loan aggregate as the machine sees it. Mirrors the `loans` row. */
export type Loan = {
  id: string;
  copyId: string;
  bookId: string;
  lenderId: string;
  borrowerId: string;
  state: LoanState;
  handoffMethod: HandoffMethod;
  dropPointId: string | null;
  handoffCode: string | null;
  requestedAt: Date;
  respondedAt: Date | null;
  outLenderConfirmedAt: Date | null;
  outBorrowerConfirmedAt: Date | null;
  handedOffAt: Date | null;
  dueAt: Date | null;
  extended: boolean;
  returnBorrowerConfirmedAt: Date | null;
  returnLenderConfirmedAt: Date | null;
  returnedAt: Date | null;
  returnCondition: CopyCondition | null;
  autoConfirmedSide: Party | null;
  declineReason: DeclineReason | null;
  poolMonth: Date | null;
};

export type Actor = { kind: "member"; memberId: string; isAdmin: boolean } | { kind: "system" };

/** Snapshot of the borrower needed for request guards. Loaded by the persistence layer. */
export type BorrowerSnapshot = {
  id: string;
  state: "registered" | "active" | "lapsed" | "suspended" | "cancelled";
  clusterId: string | null;
  trustScore: number;
  suspendedUntil: Date | null;
  needsTopup: boolean;
  plan: { concurrentLimit: number; loanPeriodDays: number } | null;
  /** Loans in requested/accepted/on_loan/overdue as borrower. */
  openLoanCount: number;
  /** Loans in requested/accepted as borrower (new-borrower rule). */
  pendingLoanCount: number;
  hasCompletedBorrow: boolean;
  /** Result of the Phase 5 activation evaluation (borrow gate + deposit). */
  activation: { ok: true } | { ok: false; reason: string };
};

export type CopySnapshot = {
  id: string;
  bookId: string;
  ownerId: string;
  clusterId: string;
  availability: "available" | "requested" | "on_loan" | "unlisted" | "lost";
  minBorrowerTrust: number;
  allowedHandoffs: HandoffMethod[];
  declineCount: number;
  verificationStatus: "unverified" | "verified";
  replacementValuePaise: number;
};

export type DropPointSnapshot = {
  id: string;
  clusterId: string;
  active: boolean;
  occupancy: number;
  capacity: number;
};

export type MachineConfig = {
  request_timeout_hours: number;
  handoff_timeout_days: number;
  handoff_auto_confirm_hours: number;
  extension_days: number;
  overdue_to_lost_days: number;
  dispute_window_hours: number;
  lost_suspension_days: number;
  copy_decline_unlist_threshold: number;
  min_trust_score: number;
};

export type Ctx = {
  now: Date;
  actor: Actor;
  config: MachineConfig;
  copy: CopySnapshot;
  borrower?: BorrowerSnapshot;
  dropPoint?: DropPointSnapshot | null;
  /** Supplied by the caller so the machine stays deterministic. */
  newId: () => string;
  newHandoffCode: () => string;
};

export type LoanEvent =
  | { type: "accept"; inHandConfirmed: boolean }
  | { type: "decline"; reason: DeclineReason }
  | { type: "timeout" }
  | {
      type: "confirm_out";
      /** Meet-up / Porter: required photo. Drop point: required code. */
      photoPath?: string;
      code?: string;
    }
  | { type: "auto_confirm_out" }
  | { type: "extend" }
  | { type: "overdue_tick" }
  | { type: "confirm_return"; photoPath?: string; code?: string; condition?: CopyCondition }
  | { type: "auto_confirm_return" }
  | { type: "lost_tick" }
  | { type: "dispute"; reason: string }
  | { type: "resolve"; resolution: DisputeResolution; chargePaise?: number; note: string };

export type LoanEventType = LoanEvent["type"];
export const LOAN_EVENT_TYPES: LoanEventType[] = [
  "accept",
  "decline",
  "timeout",
  "confirm_out",
  "auto_confirm_out",
  "extend",
  "overdue_tick",
  "confirm_return",
  "auto_confirm_return",
  "lost_tick",
  "dispute",
  "resolve",
];

export type RequestInput = {
  copyId: string;
  borrowerId: string;
  handoffMethod: HandoffMethod;
  dropPointId?: string | null;
};

export type TrustEventKind =
  | "return_on_time"
  | "return_late"
  | "book_lost"
  | "dispute_lost"
  | "no_show"
  | "request_ignored"
  | "lend_completed"
  | "borrow_completed";

export type NotificationTemplate =
  | "request_received"
  | "request_accepted"
  | "request_declined"
  | "request_expired"
  | "handoff_expired"
  | "handoff_confirmed_one_side"
  | "handoff_auto_confirmed"
  | "on_loan"
  | "extended"
  | "overdue"
  | "return_confirmed_one_side"
  | "return_auto_confirmed"
  | "returned"
  | "book_lost"
  | "dispute_opened"
  | "dispute_resolved"
  | "copy_auto_unlisted";

/** Side effects the persistence layer applies in the same transaction as the loan write. */
export type Effect =
  | { kind: "set_copy_availability"; copyId: string; availability: CopySnapshot["availability"] }
  | { kind: "increment_decline_count"; copyId: string; by: number }
  | { kind: "reset_decline_count"; copyId: string }
  | {
      kind: "unlist_copy";
      copyId: string;
      reason: "no_longer_have" | "decline_threshold" | "lender_no_show";
    }
  | { kind: "verify_copy"; copyId: string }
  | { kind: "drop_point_occupancy"; dropPointId: string; delta: 1 | -1 }
  | {
      kind: "loan_photo";
      loanId: string;
      takenBy: string;
      phase: "out" | "return";
      storagePath: string;
      condition?: CopyCondition;
    }
  | { kind: "trust_event"; memberId: string; trustKind: TrustEventKind; loanId: string }
  | { kind: "suspend_member"; memberId: string; until: Date }
  | { kind: "set_first_borrow_completed"; memberId: string; at: Date }
  | {
      kind: "ledger";
      memberId: string;
      account: "deposit" | "payout";
      ledgerKind: "deposit_charge" | "lost_book_credit";
      amountPaise: number;
      loanId: string;
      note: string;
    }
  | { kind: "create_dispute"; loanId: string; openedBy: string; reason: string }
  | {
      kind: "resolve_dispute";
      loanId: string;
      resolution: DisputeResolution;
      chargePaise: number;
      note: string;
      resolvedBy: string;
    }
  | {
      kind: "notify";
      memberId: string;
      template: NotificationTemplate;
      loanId: string;
      vars: Record<string, string | number>;
    }
  | {
      kind: "notify_admins";
      template: NotificationTemplate;
      loanId: string;
      vars: Record<string, string | number>;
    };

export type LoanErrorCode =
  | "invalid_transition"
  | "not_a_party"
  | "not_lender"
  | "not_borrower"
  | "not_admin"
  | "in_hand_required"
  | "already_confirmed"
  | "photo_required"
  | "code_required"
  | "wrong_code"
  | "collect_before_drop"
  | "condition_required"
  | "already_extended"
  | "dispute_window_closed"
  | "too_early"
  | "already_confirmed_by_both"
  | "invalid_charge"
  // request guards
  | "own_copy"
  | "copy_unavailable"
  | "cluster_mismatch"
  | "handoff_not_allowed"
  | "drop_point_required"
  | "drop_point_unavailable"
  | "borrower_not_active"
  | "borrower_suspended"
  | "trust_below_copy_min"
  | "trust_below_floor"
  | "deposit_topup_required"
  | "activation_required"
  | "at_concurrent_limit"
  | "new_borrower_one_at_a_time";

export type LoanError = { code: LoanErrorCode; message: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: LoanError };
export type Transition = { loan: Loan; effects: Effect[]; eventType: string };
