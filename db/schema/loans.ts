import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns, timestamptz } from "./_shared";
import { books } from "./books";
import { copies } from "./copies";
import { dropPoints } from "./drop-points";
import {
  copyCondition,
  declineReason,
  handoffMethod,
  loanParty,
  loanPhase,
  loanState,
} from "./enums";
import { members } from "./members";

/** States in which a copy is committed to exactly one loan. */
export const OPEN_LOAN_STATES = ["requested", "accepted", "on_loan", "overdue"] as const;

export const loans = pgTable(
  "loans",
  {
    ...baseColumns,
    copyId: uuid("copy_id")
      .notNull()
      .references(() => copies.id),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id),
    lenderId: uuid("lender_id")
      .notNull()
      .references(() => members.id),
    borrowerId: uuid("borrower_id")
      .notNull()
      .references(() => members.id),
    state: loanState("state").notNull().default("requested"),
    handoffMethod: handoffMethod("handoff_method").notNull(),
    dropPointId: uuid("drop_point_id").references(() => dropPoints.id),
    /** 6 characters, drop-point handoffs only. */
    handoffCode: text("handoff_code"),
    requestedAt: timestamptz("requested_at").notNull().defaultNow(),
    respondedAt: timestamptz("responded_at"),
    outLenderConfirmedAt: timestamptz("out_lender_confirmed_at"),
    outBorrowerConfirmedAt: timestamptz("out_borrower_confirmed_at"),
    handedOffAt: timestamptz("handed_off_at"),
    dueAt: timestamptz("due_at"),
    extended: boolean("extended").notNull().default(false),
    returnBorrowerConfirmedAt: timestamptz("return_borrower_confirmed_at"),
    returnLenderConfirmedAt: timestamptz("return_lender_confirmed_at"),
    returnedAt: timestamptz("returned_at"),
    returnCondition: copyCondition("return_condition"),
    /** Which side's confirmation was assumed when the other never confirmed (Requirement 6.4). */
    autoConfirmedSide: loanParty("auto_confirmed_side"),
    declineReason: declineReason("decline_reason"),
    /** Snapshot of the copy's rental price when requested (Requirement 5). */
    rentalPaise: integer("rental_paise").notNull().default(0),
    /** floor(rental × platform_fee_pct / 100), fixed at request time. */
    platformFeePaise: integer("platform_fee_paise").notNull().default(0),
    /** Set on accept when rental > 0; the borrower must pay before this or the loan expires. */
    paymentDueAt: timestamptz("payment_due_at"),
    /** Set by the `pay` event, or equal to responded_at for ₹0 rentals. */
    paidAt: timestamptz("paid_at"),
    /** Last reminder date, used with notifications for the once-per-day rule. */
    lastReminderOn: date("last_reminder_on", { mode: "date" }),
  },
  (t) => [
    index("loans_borrower_state_idx").on(t.borrowerId, t.state),
    index("loans_lender_state_idx").on(t.lenderId, t.state),
    index("loans_state_due_idx").on(t.state, t.dueAt),
    index("loans_state_payment_due_idx").on(t.state, t.paymentDueAt),
    index("loans_copy_idx").on(t.copyId),
    // At most one open loan per copy. Enforced in the DB so two concurrent
    // requests cannot both succeed (design.md Data Model, loans).
    uniqueIndex("loans_one_open_per_copy_uidx")
      .on(t.copyId)
      .where(sql`${t.state} in ('requested', 'accepted', 'on_loan', 'overdue')`),
  ],
);

export const loanPhotos = pgTable(
  "loan_photos",
  {
    ...baseColumns,
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id),
    takenBy: uuid("taken_by")
      .notNull()
      .references(() => members.id),
    phase: loanPhase("phase").notNull(),
    storagePath: text("storage_path").notNull(),
    condition: copyCondition("condition"),
  },
  (t) => [index("loan_photos_loan_idx").on(t.loanId)],
);

/**
 * In-loan chat. Readable only by the two parties while the loan is between
 * `accepted` and `returned` + 48 h, and by admins always (RLS, task 1.5).
 */
export const loanMessages = pgTable(
  "loan_messages",
  {
    ...baseColumns,
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => members.id),
    body: text("body").notNull(),
  },
  (t) => [index("loan_messages_loan_created_idx").on(t.loanId, t.createdAt)],
);
