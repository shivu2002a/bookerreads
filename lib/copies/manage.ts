import { and, count, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { books, copies, events, loans } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { canRelist, canUnlist, clampRentalPrice, clampReplacement } from "./rules";
import type { CopyDetailsInput } from "./schema";

export type ManageCopyError = "not_found" | "not_owner" | "on_loan" | "not_unlisted";

type Loaded =
  | { copy: typeof copies.$inferSelect; error?: undefined }
  | { copy?: undefined; error: "not_found" | "not_owner" };

async function loadOwned(db: DbOrTx, copyId: string, ownerId: string): Promise<Loaded> {
  const [copy] = await db.select().from(copies).where(eq(copies.id, copyId)).limit(1);
  if (!copy) return { error: "not_found" };
  if (copy.ownerId !== ownerId) return { error: "not_owner" };
  return { copy };
}

/** Requirement 2.7: unlisting removes the copy from search immediately. */
export async function unlistCopy(
  db: DbOrTx,
  copyId: string,
  ownerId: string,
): Promise<{ ok: true } | { ok: false; error: ManageCopyError }> {
  const loaded = await loadOwned(db, copyId, ownerId);
  if (loaded.error) return { ok: false, error: loaded.error };
  if (!canUnlist(loaded.copy.availability)) {
    return {
      ok: false,
      error: loaded.copy.availability === "unlisted" ? "not_unlisted" : "on_loan",
    };
  }
  await db
    .update(copies)
    .set({ availability: "unlisted", lastActivityAt: new Date() })
    .where(eq(copies.id, copyId));
  await db.insert(events).values({
    aggregate: "copy",
    aggregateId: copyId,
    type: "copy.unlisted",
    actorId: ownerId,
    payload: {},
  });
  return { ok: true };
}

export async function relistCopy(
  db: DbOrTx,
  copyId: string,
  ownerId: string,
): Promise<{ ok: true } | { ok: false; error: ManageCopyError }> {
  const loaded = await loadOwned(db, copyId, ownerId);
  if (loaded.error) return { ok: false, error: loaded.error };
  if (!canRelist(loaded.copy.availability)) return { ok: false, error: "not_unlisted" };
  await db
    .update(copies)
    .set({
      availability: "available",
      declineCount: 0,
      stillHaveItPingedAt: null,
      lastActivityAt: new Date(),
    })
    .where(eq(copies.id, copyId));
  await db.insert(events).values({
    aggregate: "copy",
    aggregateId: copyId,
    type: "copy.relisted",
    actorId: ownerId,
    payload: {},
  });
  return { ok: true };
}

/** Details only; the photo is not replaceable in the MVP. */
export async function updateCopyDetails(
  db: DbOrTx,
  copyId: string,
  ownerId: string,
  details: CopyDetailsInput,
  config: Pick<AppConfig, "rental_price_min_paise" | "rental_price_max_paise">,
): Promise<{ ok: true } | { ok: false; error: ManageCopyError }> {
  const loaded = await loadOwned(db, copyId, ownerId);
  if (loaded.error) return { ok: false, error: loaded.error };
  const [book] = await db
    .select({ listPricePaise: books.listPricePaise })
    .from(books)
    .where(eq(books.id, loaded.copy.bookId));
  await db
    .update(copies)
    .set({
      condition: details.condition,
      replacementValuePaise: clampReplacement(
        details.replacementValuePaise,
        book?.listPricePaise ?? null,
      ),
      rentalPricePaise: clampRentalPrice(
        details.rentalPricePaise,
        config.rental_price_min_paise,
        config.rental_price_max_paise,
      ),
      loanPeriodDays: details.loanPeriodDays,
      allowedHandoffs: details.allowedHandoffs,
      minBorrowerTrust: details.minBorrowerTrust,
      notes: details.notes || null,
    })
    .where(eq(copies.id, copyId));
  await db.insert(events).values({
    aggregate: "copy",
    aggregateId: copyId,
    type: "copy.updated",
    actorId: ownerId,
    payload: details,
  });
  return { ok: true };
}

export type ShelfCopy = {
  id: string;
  availability: (typeof copies.$inferSelect)["availability"];
  verificationStatus: (typeof copies.$inferSelect)["verificationStatus"];
  condition: (typeof copies.$inferSelect)["condition"];
  replacementValuePaise: number;
  rentalPricePaise: number;
  loanPeriodDays: number;
  listingPhotoPath: string;
  allowedHandoffs: (typeof copies.$inferSelect)["allowedHandoffs"];
  minBorrowerTrust: number;
  notes: string | null;
  createdAt: Date;
  book: {
    id: string;
    title: string;
    authors: string[];
    coverUrl: string | null;
    needsReview: boolean;
  };
  requestCount: number;
};

/** The owner's shelf, newest first, with lifetime request counts. */
export async function listShelf(db: DbOrTx, ownerId: string): Promise<ShelfCopy[]> {
  const requestCounts = db
    .select({ copyId: loans.copyId, n: count().as("n") })
    .from(loans)
    .groupBy(loans.copyId)
    .as("rc");

  const rows = await db
    .select({
      id: copies.id,
      availability: copies.availability,
      verificationStatus: copies.verificationStatus,
      condition: copies.condition,
      replacementValuePaise: copies.replacementValuePaise,
      rentalPricePaise: copies.rentalPricePaise,
      loanPeriodDays: copies.loanPeriodDays,
      listingPhotoPath: copies.listingPhotoPath,
      allowedHandoffs: copies.allowedHandoffs,
      minBorrowerTrust: copies.minBorrowerTrust,
      notes: copies.notes,
      createdAt: copies.createdAt,
      bookId: books.id,
      title: books.title,
      authors: books.authors,
      coverUrl: books.coverUrl,
      needsReview: books.needsReview,
      requestCount: sql<number>`coalesce(${requestCounts.n}, 0)`,
    })
    .from(copies)
    .innerJoin(books, eq(books.id, copies.bookId))
    .leftJoin(requestCounts, eq(requestCounts.copyId, copies.id))
    .where(eq(copies.ownerId, ownerId))
    .orderBy(desc(copies.createdAt));

  return rows.map((r) => ({
    id: r.id,
    availability: r.availability,
    verificationStatus: r.verificationStatus,
    condition: r.condition,
    replacementValuePaise: r.replacementValuePaise,
    rentalPricePaise: r.rentalPricePaise,
    loanPeriodDays: r.loanPeriodDays,
    listingPhotoPath: r.listingPhotoPath,
    allowedHandoffs: r.allowedHandoffs,
    minBorrowerTrust: r.minBorrowerTrust,
    notes: r.notes,
    createdAt: r.createdAt,
    book: {
      id: r.bookId,
      title: r.title,
      authors: r.authors,
      coverUrl: r.coverUrl,
      needsReview: r.needsReview,
    },
    requestCount: Number(r.requestCount),
  }));
}

export async function countListedCopies(db: DbOrTx, ownerId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(copies)
    .where(
      and(
        eq(copies.ownerId, ownerId),
        sql`${copies.availability} in ('available','requested','on_loan','unlisted')`,
      ),
    );
  return Number(n);
}
