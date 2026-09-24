import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { books, copies, ledgerEntries, loans, payouts, poolRuns } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { estimateCurrentMonth } from "@/lib/pool/run";

export type EarningsDashboard = {
  balancePaise: number;
  thresholdPaise: number;
  upi: { id: string | null; verified: boolean };
  thisMonth: {
    month: string;
    completedLoans: number;
    perLoanPaise: number;
    estimatePaise: number;
    revenuePaise: number;
    totalLoans: number;
  };
  nextPayoutDate: Date;
  lastStatement: {
    month: string;
    perLoanPaise: number;
    myLoans: number;
    creditPaise: number;
  } | null;
  recentPayouts: Array<{ id: string; amountPaise: number; status: string; createdAt: Date }>;
  recentCredits: Array<{
    id: string;
    kind: string;
    amountPaise: number;
    note: string | null;
    createdAt: Date;
  }>;
  mostRequested: Array<{ copyId: string; title: string; requests: number }>;
  idle: Array<{ copyId: string; title: string; listedDays: number }>;
};

/** Requirement 10.6: everything on the lender's earnings page. */
export async function loadEarnings(
  db: Db,
  member: { id: string; payoutBalancePaise: number; upiId: string | null; upiVerified: boolean },
  config: AppConfig,
  now = new Date(),
): Promise<EarningsDashboard> {
  const since90 = new Date(now.getTime() - 90 * 86_400_000);
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const [estimate, lastRun, recentPayouts, recentCredits, requested, idle] = await Promise.all([
    estimateCurrentMonth(db, member.id, config, now),
    db.select().from(poolRuns).orderBy(desc(poolRuns.month)).limit(1),
    db
      .select({
        id: payouts.id,
        amountPaise: payouts.amountPaise,
        status: payouts.status,
        createdAt: payouts.createdAt,
      })
      .from(payouts)
      .where(eq(payouts.memberId, member.id))
      .orderBy(desc(payouts.createdAt))
      .limit(5),
    db
      .select({
        id: ledgerEntries.id,
        kind: ledgerEntries.kind,
        amountPaise: ledgerEntries.amountPaise,
        note: ledgerEntries.note,
        createdAt: ledgerEntries.createdAt,
      })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.memberId, member.id), eq(ledgerEntries.account, "payout")))
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(10),
    db
      .select({ copyId: copies.id, title: books.title, requests: sql<number>`count(${loans.id})` })
      .from(copies)
      .innerJoin(books, eq(books.id, copies.bookId))
      .leftJoin(loans, and(eq(loans.copyId, copies.id), sql`${loans.requestedAt} >= ${since90}`))
      .where(
        and(
          eq(copies.ownerId, member.id),
          inArray(copies.availability, ["available", "requested", "on_loan"]),
        ),
      )
      .groupBy(copies.id, books.title)
      .having(sql`count(${loans.id}) > 0`)
      .orderBy(desc(sql`count(${loans.id})`))
      .limit(5),
    db
      .select({ copyId: copies.id, title: books.title, createdAt: copies.createdAt })
      .from(copies)
      .innerJoin(books, eq(books.id, copies.bookId))
      .where(
        and(
          eq(copies.ownerId, member.id),
          eq(copies.availability, "available"),
          sql`${copies.createdAt} <= ${since90}`,
          sql`not exists (select 1 from loans l where l.copy_id = ${copies.id} and l.requested_at >= ${since90})`,
        ),
      )
      .orderBy(copies.createdAt)
      .limit(10),
  ]);

  const run = lastRun[0];
  const mine = run?.statement.lenders.find((l) => l.memberId === member.id);

  return {
    balancePaise: member.payoutBalancePaise,
    thresholdPaise: config.payout_threshold_paise,
    upi: { id: member.upiId, verified: member.upiVerified },
    thisMonth: {
      month: estimate.month,
      completedLoans: estimate.myLoans,
      perLoanPaise: estimate.perLoanPaise,
      estimatePaise: estimate.estimatePaise,
      revenuePaise: estimate.revenuePaise,
      totalLoans: estimate.totalLoans,
    },
    nextPayoutDate: nextMonth,
    lastStatement: run
      ? {
          month: run.statement.month,
          perLoanPaise: run.perLoanPaise,
          myLoans: mine?.loanCount ?? 0,
          creditPaise: mine?.creditPaise ?? 0,
        }
      : null,
    recentPayouts,
    recentCredits,
    mostRequested: requested.map((r) => ({ ...r, requests: Number(r.requests) })),
    idle: idle.map((r) => ({
      copyId: r.copyId,
      title: r.title,
      listedDays: Math.floor((now.getTime() - r.createdAt.getTime()) / 86_400_000),
    })),
  };
}
