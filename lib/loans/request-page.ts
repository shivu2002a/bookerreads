import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { books, copies, dropPoints, members } from "@/db/schema";

export type RequestPageData = {
  copy: {
    id: string;
    condition: "like_new" | "good" | "worn";
    availability: string;
    allowedHandoffs: Array<"meetup" | "drop_point" | "courier">;
    replacementValuePaise: number;
    clusterId: string;
    ownerId: string;
  };
  book: { id: string; title: string; authors: string[]; coverUrl: string | null };
  lender: { id: string; displayName: string | null; trustScore: number };
  dropPoints: Array<{ id: string; name: string; address: string; spaceLeft: number }>;
};

/** Everything the "request this copy" page needs. */
export async function loadRequestPage(db: DbOrTx, copyId: string): Promise<RequestPageData | null> {
  const [row] = await db
    .select({
      id: copies.id,
      condition: copies.condition,
      availability: copies.availability,
      allowedHandoffs: copies.allowedHandoffs,
      replacementValuePaise: copies.replacementValuePaise,
      clusterId: copies.clusterId,
      ownerId: copies.ownerId,
      bookId: books.id,
      title: books.title,
      authors: books.authors,
      coverUrl: books.coverUrl,
      lenderName: members.displayName,
      lenderTrust: members.trustScore,
    })
    .from(copies)
    .innerJoin(books, eq(books.id, copies.bookId))
    .innerJoin(members, eq(members.id, copies.ownerId))
    .where(eq(copies.id, copyId));
  if (!row) return null;

  const dps = row.allowedHandoffs.includes("drop_point")
    ? await db
        .select({
          id: dropPoints.id,
          name: dropPoints.name,
          address: dropPoints.address,
          spaceLeft: sql<number>`${dropPoints.capacity} - ${dropPoints.occupancy}`,
        })
        .from(dropPoints)
        .where(and(eq(dropPoints.clusterId, row.clusterId), eq(dropPoints.active, true)))
        .orderBy(dropPoints.name)
    : [];

  return {
    copy: {
      id: row.id,
      condition: row.condition,
      availability: row.availability,
      allowedHandoffs: row.allowedHandoffs,
      replacementValuePaise: row.replacementValuePaise,
      clusterId: row.clusterId,
      ownerId: row.ownerId,
    },
    book: { id: row.bookId, title: row.title, authors: row.authors, coverUrl: row.coverUrl },
    lender: { id: row.ownerId, displayName: row.lenderName, trustScore: row.lenderTrust },
    dropPoints: dps.map((d) => ({ ...d, spaceLeft: Number(d.spaceLeft) })),
  };
}
