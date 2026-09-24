import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { books, dropPoints, loans } from "@/db/schema";
import { safeEqual } from "@/lib/security/constant-time";

export type DropPointAction = {
  loanId: string;
  bookTitle: string;
  /** What the viewer does here: drop the book, or collect it. */
  action: "drop" | "collect";
  phase: "out" | "return";
};

export type DropPointPage = {
  dropPoint: {
    id: string;
    name: string;
    address: string;
    hours: unknown;
    occupancy: number;
    capacity: number;
  };
  /** Null when the secret in the QR does not match (poster rotated). */
  verified: boolean;
  actions: DropPointAction[];
};

/**
 * Landing for a scanned poster QR (Requirement 6.3, 12.1). Verifies the QR
 * secret and lists what the signed-in member can do at this venue right now.
 */
export async function loadDropPointPage(
  db: DbOrTx,
  dropPointId: string,
  secret: string | undefined,
  memberId: string | null,
): Promise<DropPointPage | null> {
  const [dp] = await db.select().from(dropPoints).where(eq(dropPoints.id, dropPointId));
  if (!dp || !dp.active) return null;
  const verified = Boolean(secret) && safeEqual(secret!, dp.qrSecret);

  let actions: DropPointAction[] = [];
  if (verified && memberId) {
    const rows = await db
      .select({
        id: loans.id,
        state: loans.state,
        lenderId: loans.lenderId,
        borrowerId: loans.borrowerId,
        outL: loans.outLenderConfirmedAt,
        outB: loans.outBorrowerConfirmedAt,
        retL: loans.returnLenderConfirmedAt,
        retB: loans.returnBorrowerConfirmedAt,
        title: books.title,
      })
      .from(loans)
      .innerJoin(books, eq(books.id, loans.bookId))
      .where(
        and(
          eq(loans.dropPointId, dropPointId),
          inArray(loans.state, ["accepted", "on_loan", "overdue"]),
          sql`${loans.lenderId} = ${memberId} or ${loans.borrowerId} = ${memberId}`,
        ),
      );

    for (const r of rows) {
      const isLender = r.lenderId === memberId;
      if (r.state === "accepted") {
        if (isLender && !r.outL)
          actions.push({ loanId: r.id, bookTitle: r.title, action: "drop", phase: "out" });
        if (!isLender && r.outL && !r.outB)
          actions.push({ loanId: r.id, bookTitle: r.title, action: "collect", phase: "out" });
      } else {
        if (!isLender && !r.retB)
          actions.push({ loanId: r.id, bookTitle: r.title, action: "drop", phase: "return" });
        if (isLender && r.retB && !r.retL)
          actions.push({ loanId: r.id, bookTitle: r.title, action: "collect", phase: "return" });
      }
    }
    actions = actions.sort((a, b) => a.bookTitle.localeCompare(b.bookTitle));
  }

  return {
    dropPoint: {
      id: dp.id,
      name: dp.name,
      address: dp.address,
      hours: dp.hours,
      occupancy: dp.occupancy,
      capacity: dp.capacity,
    },
    verified,
    actions,
  };
}
