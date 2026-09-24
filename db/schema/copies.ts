import { index, integer, pgTable, smallint, text, uuid } from "drizzle-orm/pg-core";
import { baseColumns, timestamptz } from "./_shared";
import { books } from "./books";
import { clusters } from "./clusters";
import { copyAvailability, copyCondition, handoffMethod, verificationStatus } from "./enums";
import { members } from "./members";

/** A physical book owned by a member. The unit that is listed and lent. */
export const copies = pgTable(
  "copies",
  {
    ...baseColumns,
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => members.id),
    /** Denormalised from the owner at write time so browse queries need no join. */
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id),
    condition: copyCondition("condition").notNull(),
    replacementValuePaise: integer("replacement_value_paise").notNull(),
    listingPhotoPath: text("listing_photo_path").notNull(),
    notes: text("notes"),
    allowedHandoffs: handoffMethod("allowed_handoffs").array().notNull(),
    minBorrowerTrust: smallint("min_borrower_trust").notNull().default(0),
    /** What a borrower pays per loan, set by the lister (Requirement 2.4). 0 = lend for free. */
    rentalPricePaise: integer("rental_price_paise").notNull().default(0),
    /** 14, 21, or 28 days; drives due_at (Requirement 6.5). */
    loanPeriodDays: smallint("loan_period_days").notNull().default(21),
    availability: copyAvailability("availability").notNull().default("available"),
    verificationStatus: verificationStatus("verification_status").notNull().default("unverified"),
    /** Declines and expiries since the last completed loan; 3 triggers auto-unlist (Requirement 5.8). */
    declineCount: smallint("decline_count").notNull().default(0),
    lastActivityAt: timestamptz("last_activity_at").notNull().defaultNow(),
    stillHaveItPingedAt: timestamptz("still_have_it_pinged_at"),
  },
  (t) => [
    index("copies_cluster_book_availability_idx").on(t.clusterId, t.bookId, t.availability),
    index("copies_owner_availability_idx").on(t.ownerId, t.availability),
    index("copies_last_activity_idx").on(t.lastActivityAt),
  ],
);
