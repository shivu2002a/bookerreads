import { and, count, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { books, copies, events, members } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { clampReplacement, remainingListingAllowance } from "./rules";
import type { CopyDetailsInput } from "./schema";

export type CreateCopyInput = CopyDetailsInput & {
  ownerId: string;
  bookId: string;
  listingPhotoPath: string;
};

export type CreateCopyError =
  | { code: "book_not_found" }
  | { code: "member_not_onboarded" }
  | { code: "listing_cap_reached"; cap: number; ageDays: number };

export type CreateCopyResult =
  { ok: true; copy: typeof copies.$inferSelect } | { ok: false; error: CreateCopyError };

/**
 * Requirements 2.4–2.6. Sets availability=available and verification=unverified,
 * denormalises cluster_id from the owner, clamps the replacement value to the
 * ₹100–₹1000 range, and enforces the new-account cap.
 */
export async function createCopy(
  db: DbOrTx,
  input: CreateCopyInput,
  config: AppConfig,
  now = new Date(),
): Promise<CreateCopyResult> {
  const [owner] = await db
    .select({ id: members.id, clusterId: members.clusterId, createdAt: members.createdAt })
    .from(members)
    .where(eq(members.id, input.ownerId))
    .limit(1);
  if (!owner?.clusterId) return { ok: false, error: { code: "member_not_onboarded" } };

  const [book] = await db
    .select({
      id: books.id,
      listPricePaise: books.listPricePaise,
      mergedIntoId: books.mergedIntoId,
    })
    .from(books)
    .where(eq(books.id, input.bookId))
    .limit(1);
  if (!book) return { ok: false, error: { code: "book_not_found" } };
  const bookId = book.mergedIntoId ?? book.id;

  const [{ n: currentCount }] = await db
    .select({ n: count() })
    .from(copies)
    .where(
      and(
        eq(copies.ownerId, owner.id),
        inArray(copies.availability, ["available", "requested", "on_loan", "unlisted"]),
      ),
    );

  const allowance = remainingListingAllowance({
    memberCreatedAt: owner.createdAt,
    now,
    currentCopyCount: Number(currentCount),
    newAccountAgeDays: config.new_account_age_days,
    cap: config.new_account_listing_cap,
  });
  if (allowance <= 0) {
    return {
      ok: false,
      error: {
        code: "listing_cap_reached",
        cap: config.new_account_listing_cap,
        ageDays: config.new_account_age_days,
      },
    };
  }

  const [copy] = await db
    .insert(copies)
    .values({
      bookId,
      ownerId: owner.id,
      clusterId: owner.clusterId,
      condition: input.condition,
      replacementValuePaise: clampReplacement(input.replacementValuePaise, book.listPricePaise),
      listingPhotoPath: input.listingPhotoPath,
      notes: input.notes || null,
      allowedHandoffs: input.allowedHandoffs,
      minBorrowerTrust: input.minBorrowerTrust,
      availability: "available",
      verificationStatus: "unverified",
      lastActivityAt: now,
    })
    .returning();

  await db.insert(events).values({
    aggregate: "copy",
    aggregateId: copy.id,
    type: "copy.created",
    actorId: owner.id,
    payload: {
      bookId,
      condition: copy.condition,
      replacementValuePaise: copy.replacementValuePaise,
    },
  });

  return { ok: true, copy };
}

/**
 * Requirement 2.2: when no catalogue matches, the member types the details and
 * photographs the title page; the book is flagged for admin review.
 */
export async function createManualBook(
  db: DbOrTx,
  input: {
    title: string;
    authors: string[];
    language: string;
    reviewPhotoPath: string;
    createdBy: string;
  },
): Promise<typeof books.$inferSelect> {
  const [book] = await db
    .insert(books)
    .values({
      isbn13: null,
      title: input.title,
      authors: input.authors,
      language: input.language,
      source: "manual",
      needsReview: true,
      reviewPhotoPath: input.reviewPhotoPath,
    })
    .returning();
  await db.insert(events).values({
    aggregate: "copy",
    aggregateId: book.id,
    type: "book.manual_entry",
    actorId: input.createdBy,
    payload: { title: input.title },
  });
  return book;
}
