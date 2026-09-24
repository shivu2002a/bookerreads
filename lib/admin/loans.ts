import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db, DbOrTx } from "@/db/client";
import { books, copies, disputes, events, loans, members } from "@/db/schema";
import { OPEN_LOAN_STATES } from "@/db/schema";
import type { LoanState } from "@/lib/loans/types";
import { adminAction } from "./act";

const lenderM = alias(members, "lender");
const borrowerM = alias(members, "borrower");

/** Requirement 13.3: search by loan id, member name, or book title. */
export async function searchLoans(db: DbOrTx, query: string, limit = 50) {
  const q = query.trim();
  const isUuid = /^[0-9a-f-]{36}$/i.test(q);
  const where = !q
    ? sql`true`
    : isUuid
      ? eq(loans.id, q)
      : or(
          ilike(books.title, `%${q}%`),
          ilike(lenderM.displayName, `%${q}%`),
          ilike(borrowerM.displayName, `%${q}%`),
        );
  return db
    .select({
      id: loans.id,
      state: loans.state,
      requestedAt: loans.requestedAt,
      dueAt: loans.dueAt,
      title: books.title,
      lender: lenderM.displayName,
      borrower: borrowerM.displayName,
      handoff: loans.handoffMethod,
    })
    .from(loans)
    .innerJoin(books, eq(books.id, loans.bookId))
    .innerJoin(lenderM, eq(lenderM.id, loans.lenderId))
    .innerJoin(borrowerM, eq(borrowerM.id, loans.borrowerId))
    .where(where)
    .orderBy(desc(loans.requestedAt))
    .limit(limit);
}

/** Copy availability that must hold for each loan state, used by the override. */
function copyAvailabilityFor(
  state: LoanState,
): "available" | "requested" | "on_loan" | "lost" | null {
  switch (state) {
    case "requested":
    case "accepted":
      return "requested";
    case "on_loan":
    case "overdue":
      return "on_loan";
    case "lost":
      return "lost";
    case "declined":
    case "expired":
    case "returned":
    case "disputed":
    case "resolved":
      return "available";
  }
}

/**
 * Requirement 13.3: admin state override with a mandatory reason. Bypasses the
 * machine on purpose (that is what an override is for) but keeps the copy
 * consistent and refuses to open a second loan on a copy that already has one.
 */
export async function overrideLoanState(
  db: Db,
  input: { adminId: string; loanId: string; toState: LoanState; reason: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await adminAction(
      db,
      {
        adminId: input.adminId,
        target: { type: "loan", id: input.loanId },
        action: "loan.override_state",
        reason: input.reason,
        payload: { toState: input.toState },
      },
      async (tx) => {
        const [loan] = await tx
          .select()
          .from(loans)
          .where(eq(loans.id, input.loanId))
          .for("update");
        if (!loan) throw new Error("Loan not found.");
        await tx.select().from(copies).where(eq(copies.id, loan.copyId)).for("update");
        const opening = (OPEN_LOAN_STATES as readonly string[]).includes(input.toState);
        if (opening) {
          const [other] = await tx
            .select({ id: loans.id })
            .from(loans)
            .where(
              sql`${loans.copyId} = ${loan.copyId} and ${loans.id} <> ${loan.id} and ${loans.state} in ('requested','accepted','on_loan','overdue')`,
            );
          if (other) throw new Error("Another open loan already holds this copy.");
        }
        const patch: Partial<typeof loans.$inferInsert> = { state: input.toState };
        if (input.toState === "returned" && !loan.returnedAt) {
          patch.returnedAt = new Date();
        }
        await tx.update(loans).set(patch).where(eq(loans.id, loan.id));
        const avail = copyAvailabilityFor(input.toState);
        if (avail)
          await tx.update(copies).set({ availability: avail }).where(eq(copies.id, loan.copyId));
        await tx.insert(events).values({
          aggregate: "loan",
          aggregateId: loan.id,
          type: "loan.admin_override",
          actorId: input.adminId,
          payload: { from: loan.state, to: input.toState, reason: input.reason },
        });
      },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function listOpenDisputes(db: DbOrTx) {
  return db
    .select({
      id: disputes.id,
      loanId: disputes.loanId,
      reason: disputes.reason,
      openedBy: disputes.openedBy,
      createdAt: disputes.createdAt,
      title: books.title,
      lender: lenderM.displayName,
      borrower: borrowerM.displayName,
      replacementValuePaise: copies.replacementValuePaise,
      state: disputes.state,
      resolution: disputes.resolution,
    })
    .from(disputes)
    .innerJoin(loans, eq(loans.id, disputes.loanId))
    .innerJoin(books, eq(books.id, loans.bookId))
    .innerJoin(copies, eq(copies.id, loans.copyId))
    .innerJoin(lenderM, eq(lenderM.id, loans.lenderId))
    .innerJoin(borrowerM, eq(borrowerM.id, loans.borrowerId))
    .orderBy(sql`${disputes.state} = 'open' desc`, disputes.createdAt)
    .limit(100);
}
