import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@/db/client";
import { books, copies, events, loans } from "@/db/schema";
import { toIsbn13 } from "@/lib/catalogue/isbn";
import { adminAction } from "./act";

export async function listReviewQueue(db: DbOrTx) {
  return db
    .select({
      book: books,
      copies: sql<number>`(select count(*) from copies c where c.book_id = ${books.id})`,
    })
    .from(books)
    .where(eq(books.needsReview, true))
    .orderBy(books.createdAt);
}

export async function getBookAdmin(db: DbOrTx, id: string) {
  const [b] = await db.select().from(books).where(eq(books.id, id));
  if (!b) return null;
  const [{ copyCount }] = await db
    .select({ copyCount: sql<number>`count(*)` })
    .from(copies)
    .where(eq(copies.bookId, id));
  return { ...b, copyCount: Number(copyCount) };
}

export const bookEditSchema = z.object({
  title: z.string().trim().min(1).max(200),
  authors: z
    .string()
    .trim()
    .min(1)
    .transform((s) =>
      s
        .split(/[,;]/)
        .map((a) => a.trim())
        .filter(Boolean),
    ),
  isbn13: z.string().trim().optional().default(""),
  publisher: z.string().trim().max(120).optional().default(""),
  publishedYear: z.coerce.number().int().min(1400).max(2100).optional().nullable(),
  language: z.string().trim().length(2).default("en"),
  listPricePaise: z.coerce.number().int().min(0).optional().nullable(),
});

/** Requirement 13.6: correct metadata; approving clears needs_review. */
export async function editBook(
  db: Db,
  input: {
    adminId: string;
    bookId: string;
    reason: string;
    approve: boolean;
    data: z.infer<typeof bookEditSchema>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const isbn13 = input.data.isbn13 ? toIsbn13(input.data.isbn13) : null;
  if (input.data.isbn13 && !isbn13) return { ok: false, error: "That ISBN is not valid." };
  try {
    await adminAction(
      db,
      {
        adminId: input.adminId,
        target: { type: "book", id: input.bookId },
        action: input.approve ? "book.approve" : "book.edit",
        reason: input.reason,
        payload: { ...input.data, isbn13 },
      },
      async (tx) => {
        if (isbn13) {
          const [clash] = await tx
            .select({ id: books.id })
            .from(books)
            .where(sql`${books.isbn13} = ${isbn13} and ${books.id} <> ${input.bookId}`);
          if (clash)
            throw new Error(`Another book already has ISBN ${isbn13}. Merge into it instead.`);
        }
        await tx
          .update(books)
          .set({
            title: input.data.title,
            authors: input.data.authors,
            isbn13,
            publisher: input.data.publisher || null,
            publishedYear: input.data.publishedYear ?? null,
            language: input.data.language,
            listPricePaise: input.data.listPricePaise ?? null,
            ...(input.approve ? { needsReview: false } : {}),
          })
          .where(eq(books.id, input.bookId));
      },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Requirement 13.6: merge a duplicate into the survivor. Copies and loans are
 * repointed; the duplicate keeps a merged_into_id so old links redirect.
 */
export async function mergeBooks(
  db: Db,
  input: { adminId: string; duplicateId: string; survivorId: string; reason: string },
): Promise<{ ok: true; movedCopies: number } | { ok: false; error: string }> {
  if (input.duplicateId === input.survivorId)
    return { ok: false, error: "Pick two different books." };
  try {
    const moved = await adminAction(
      db,
      {
        adminId: input.adminId,
        target: { type: "book", id: input.duplicateId },
        action: "book.merge",
        reason: input.reason,
        payload: { survivorId: input.survivorId },
      },
      async (tx) => {
        const [survivor] = await tx
          .select({ id: books.id, mergedIntoId: books.mergedIntoId })
          .from(books)
          .where(eq(books.id, input.survivorId));
        if (!survivor) throw new Error("Survivor not found.");
        if (survivor.mergedIntoId)
          throw new Error("The survivor has itself been merged; pick the final record.");
        const movedCopies = await tx
          .update(copies)
          .set({ bookId: input.survivorId })
          .where(eq(copies.bookId, input.duplicateId))
          .returning({ id: copies.id });
        await tx
          .update(loans)
          .set({ bookId: input.survivorId })
          .where(eq(loans.bookId, input.duplicateId));
        await tx
          .update(books)
          .set({ mergedIntoId: input.survivorId, needsReview: false, isbn13: null })
          .where(eq(books.id, input.duplicateId));
        await tx.insert(events).values({
          aggregate: "copy",
          aggregateId: input.duplicateId,
          type: "book.merged",
          actorId: input.adminId,
          payload: { survivorId: input.survivorId, movedCopies: movedCopies.length },
        });
        return movedCopies.length;
      },
    );
    return { ok: true, movedCopies: moved };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function searchBooksAdmin(db: DbOrTx, q: string) {
  const isbn = toIsbn13(q);
  return db
    .select({
      id: books.id,
      title: books.title,
      authors: books.authors,
      isbn13: books.isbn13,
      mergedIntoId: books.mergedIntoId,
    })
    .from(books)
    .where(isbn ? eq(books.isbn13, isbn) : sql`${books.title} ilike ${"%" + q + "%"}`)
    .orderBy(desc(books.createdAt))
    .limit(20);
}
