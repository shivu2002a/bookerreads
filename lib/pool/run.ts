import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  events,
  loans,
  notifications,
  poolRuns,
  subscriptionPayments,
  type PoolStatement,
} from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { postEntry } from "@/lib/ledger/post";
import { computePool } from "./compute";

export const startOfMonthUtc = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const previousMonthUtc = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export type PoolRunResult =
  | { status: "created"; poolRunId: string; statement: PoolStatement }
  | { status: "exists"; poolRunId: string; statement: PoolStatement };

/** Loans that count toward the pool: reached `returned` in the month (Open Decision 1: disputes still count). */
export const POOL_LOAN_STATES = ["returned", "disputed", "resolved"] as const;

/**
 * Requirement 10.1–10.3. Idempotent on the month: a second run returns the
 * existing statement without posting anything. Everything happens in one
 * transaction so a failure leaves no half-credited month.
 */
export async function runPool(
  db: Db,
  month: Date,
  config: AppConfig,
  now = new Date(),
): Promise<PoolRunResult> {
  const m = startOfMonthUtc(month);
  return db.transaction(async (tx) => {
    // Serialise concurrent runs for the same month (e.g. cron retry racing a manual run).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pool_run:" + isoDate(m)}))`);

    const [existing] = await tx.select().from(poolRuns).where(eq(poolRuns.month, m));
    if (existing)
      return { status: "exists", poolRunId: existing.id, statement: existing.statement };

    const [{ revenue }] = await tx
      .select({ revenue: sql<number>`coalesce(sum(${subscriptionPayments.amountPaise}), 0)` })
      .from(subscriptionPayments)
      .where(
        and(eq(subscriptionPayments.status, "captured"), eq(subscriptionPayments.poolMonth, m)),
      );

    const counts = await tx
      .select({ lenderId: loans.lenderId, n: sql<number>`count(*)` })
      .from(loans)
      .where(and(eq(loans.poolMonth, m), inArray(loans.state, [...POOL_LOAN_STATES])))
      .groupBy(loans.lenderId);

    const [prev] = await tx
      .select({ carryOut: poolRuns.carryOutPaise })
      .from(poolRuns)
      .where(lt(poolRuns.month, m))
      .orderBy(desc(poolRuns.month))
      .limit(1);

    const out = computePool({
      revenuePaise: Number(revenue),
      poolPct: config.pool_pct,
      carryInPaise: prev?.carryOut ?? 0,
      loanCounts: new Map(counts.map((c) => [c.lenderId, Number(c.n)])),
    });

    const statement: PoolStatement = {
      month: isoDate(m),
      revenuePaise: Number(revenue),
      poolPct: config.pool_pct,
      carryInPaise: prev?.carryOut ?? 0,
      poolPaise: out.poolPaise,
      loanCount: out.loanCount,
      perLoanPaise: out.perLoanPaise,
      carryOutPaise: out.carryOutPaise,
      lenders: out.credits,
    };

    const [run] = await tx
      .insert(poolRuns)
      .values({
        month: m,
        revenuePaise: statement.revenuePaise,
        poolPct: statement.poolPct,
        poolPaise: statement.poolPaise,
        carryInPaise: statement.carryInPaise,
        loanCount: statement.loanCount,
        perLoanPaise: statement.perLoanPaise,
        carryOutPaise: statement.carryOutPaise,
        statement,
        createdAt: now,
      })
      .returning({ id: poolRuns.id });

    for (const c of out.credits) {
      if (c.creditPaise <= 0) continue;
      await postEntry(tx, {
        memberId: c.memberId,
        account: "payout",
        kind: "pool_credit",
        amountPaise: c.creditPaise,
        poolRunId: run.id,
        note: `Pool share for ${statement.month}: ${c.loanCount} loan(s) x ${out.perLoanPaise}`,
        createdAt: now,
      });
      await tx.insert(notifications).values({
        memberId: c.memberId,
        template: "pool_statement",
        channel: "whatsapp",
        payload: { month: statement.month, loans: c.loanCount, creditPaise: c.creditPaise },
        status: "queued",
        createdAt: now,
      });
    }
    await tx.insert(events).values({
      aggregate: "pool_run",
      aggregateId: run.id,
      type: "pool_run.completed",
      payload: statement as unknown as Record<string, unknown>,
      createdAt: now,
    });

    return { status: "created", poolRunId: run.id, statement };
  });
}

/** Live estimate for the earnings dashboard: this month so far, as if the pool ran now. */
export async function estimateCurrentMonth(
  db: Db,
  memberId: string,
  config: AppConfig,
  now = new Date(),
) {
  const m = startOfMonthUtc(now);
  const [{ revenue }] = await db
    .select({ revenue: sql<number>`coalesce(sum(${subscriptionPayments.amountPaise}), 0)` })
    .from(subscriptionPayments)
    .where(and(eq(subscriptionPayments.status, "captured"), eq(subscriptionPayments.poolMonth, m)));
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(loans)
    .where(and(eq(loans.poolMonth, m), inArray(loans.state, [...POOL_LOAN_STATES])));
  const [{ mine }] = await db
    .select({ mine: sql<number>`count(*)` })
    .from(loans)
    .where(
      and(
        eq(loans.poolMonth, m),
        eq(loans.lenderId, memberId),
        inArray(loans.state, [...POOL_LOAN_STATES]),
      ),
    );
  const [prev] = await db
    .select({ carryOut: poolRuns.carryOutPaise })
    .from(poolRuns)
    .where(lt(poolRuns.month, m))
    .orderBy(desc(poolRuns.month))
    .limit(1);
  const out = computePool({
    revenuePaise: Number(revenue),
    poolPct: config.pool_pct,
    carryInPaise: prev?.carryOut ?? 0,
    loanCounts: new Map([
      [memberId, Number(mine)],
      ["__others__", Number(total) - Number(mine)],
    ]),
  });
  return {
    month: isoDate(m),
    revenuePaise: Number(revenue),
    totalLoans: Number(total),
    myLoans: Number(mine),
    perLoanPaise: out.perLoanPaise,
    estimatePaise: out.perLoanPaise * Number(mine),
  };
}
