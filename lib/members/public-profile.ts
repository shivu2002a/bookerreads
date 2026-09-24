import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { books, clusters, copies, loans, members } from "@/db/schema";
import {
  ACCEPTANCE_WINDOW,
  acceptanceRate,
  type AnsweredRequestState,
} from "@/lib/trust/acceptance";

export type PublicProfile = {
  id: string;
  displayName: string;
  cluster: { id: string; slug: string; name: string } | null;
  trustScore: number;
  memberSince: Date;
  /** null until the lender has received at least 3 requests (Requirement 9.5). */
  acceptanceRate: number | null;
  requestsReceived: number;
  completedLends: number;
  copies: Array<{
    id: string;
    condition: (typeof copies.$inferSelect)["condition"];
    verificationStatus: (typeof copies.$inferSelect)["verificationStatus"];
    availability: "available" | "on_loan";
    listingPhotoPath: string;
    book: { id: string; title: string; authors: string[]; coverUrl: string | null };
  }>;
};

/**
 * Acceptance rate over the lender's last 20 answered requests (lib/trust/acceptance).
 */
export async function lenderAcceptanceRate(
  db: DbOrTx,
  lenderId: string,
): Promise<{ rate: number | null; received: number }> {
  const recent = await db
    .select({ state: loans.state })
    .from(loans)
    .where(and(eq(loans.lenderId, lenderId), sql`${loans.state} <> 'requested'`))
    .orderBy(desc(loans.requestedAt))
    .limit(ACCEPTANCE_WINDOW);
  const { rate, answered } = acceptanceRate(recent.map((l) => l.state as AnsweredRequestState));
  return { rate, received: answered };
}

/**
 * Requirement 3.5 / 15.1: what any member may see about another. No phone,
 * no address, no balances, no state beyond what the shelf implies.
 */
export async function getPublicProfile(
  db: DbOrTx,
  memberId: string,
): Promise<PublicProfile | null> {
  const [m] = await db
    .select({
      id: members.id,
      displayName: members.displayName,
      trustScore: members.trustScore,
      createdAt: members.createdAt,
      deletedAt: members.deletedAt,
      clusterId: clusters.id,
      clusterSlug: clusters.slug,
      clusterName: clusters.name,
    })
    .from(members)
    .leftJoin(clusters, eq(clusters.id, members.clusterId))
    .where(eq(members.id, memberId))
    .limit(1);
  if (!m || m.deletedAt || !m.displayName) return null;

  const [{ rate, received }, [{ completed }], shelf] = await Promise.all([
    lenderAcceptanceRate(db, memberId),
    db
      .select({ completed: sql<number>`count(*)` })
      .from(loans)
      .where(
        and(
          eq(loans.lenderId, memberId),
          inArray(loans.state, ["returned", "disputed", "resolved"]),
        ),
      ),
    db
      .select({
        id: copies.id,
        condition: copies.condition,
        verificationStatus: copies.verificationStatus,
        availability: copies.availability,
        listingPhotoPath: copies.listingPhotoPath,
        bookId: books.id,
        title: books.title,
        authors: books.authors,
        coverUrl: books.coverUrl,
      })
      .from(copies)
      .innerJoin(books, eq(books.id, copies.bookId))
      .where(
        and(eq(copies.ownerId, memberId), inArray(copies.availability, ["available", "on_loan"])),
      )
      .orderBy(desc(copies.verificationStatus), desc(copies.createdAt)),
  ]);

  return {
    id: m.id,
    displayName: m.displayName,
    cluster: m.clusterId ? { id: m.clusterId, slug: m.clusterSlug!, name: m.clusterName! } : null,
    trustScore: m.trustScore,
    memberSince: m.createdAt,
    acceptanceRate: rate,
    requestsReceived: received,
    completedLends: Number(completed),
    copies: shelf.map((c) => ({
      id: c.id,
      condition: c.condition,
      verificationStatus: c.verificationStatus,
      availability: c.availability as "available" | "on_loan",
      listingPhotoPath: c.listingPhotoPath,
      book: { id: c.bookId, title: c.title, authors: c.authors, coverUrl: c.coverUrl },
    })),
  };
}
