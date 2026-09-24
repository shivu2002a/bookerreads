import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ledgerEntries, members, payouts, poolRuns } from "@/db/schema";
import { seed } from "@/db/seed/run";
import { CONFIG_DEFAULTS } from "@/lib/config/schema";
import {
  generatePayoutBatch,
  markBatchExported,
  markPayoutResult,
  payoutBatchCsv,
} from "@/lib/payouts/batch";
import { createTestDb, type TestDb } from "@/test/db";
import { computePool } from "./compute";
import { estimateCurrentMonth, runPool } from "./run";

describe("computePool", () => {
  it("splits the pool equally per loan and carries the remainder", () => {
    const out = computePool({
      revenuePaise: 100000,
      poolPct: 30,
      carryInPaise: 0,
      loanCounts: new Map([
        ["a", 2],
        ["b", 1],
      ]),
    });
    expect(out.poolPaise).toBe(30000);
    expect(out.loanCount).toBe(3);
    expect(out.perLoanPaise).toBe(10000);
    expect(out.carryOutPaise).toBe(0);
    expect(out.credits).toEqual([
      { memberId: "a", loanCount: 2, creditPaise: 20000 },
      { memberId: "b", loanCount: 1, creditPaise: 10000 },
    ]);
  });

  it("rounds down and leaves a remainder smaller than the loan count", () => {
    const out = computePool({
      revenuePaise: 100001,
      poolPct: 30,
      carryInPaise: 0,
      loanCounts: new Map([["a", 7]]),
    });
    expect(out.poolPaise).toBe(30000); // floor(30000.3)
    expect(out.perLoanPaise).toBe(4285);
    expect(out.carryOutPaise).toBe(30000 - 4285 * 7);
    expect(out.carryOutPaise).toBeLessThan(7);
    expect(out.credits[0].creditPaise + out.carryOutPaise).toBe(out.poolPaise);
  });

  it("carries the whole pool when there were no loans", () => {
    const out = computePool({
      revenuePaise: 50000,
      poolPct: 30,
      carryInPaise: 123,
      loanCounts: new Map(),
    });
    expect(out).toMatchObject({
      poolPaise: 15123,
      loanCount: 0,
      perLoanPaise: 0,
      carryOutPaise: 15123,
      credits: [],
    });
  });

  it("distributes carry-in even with zero revenue", () => {
    const out = computePool({
      revenuePaise: 0,
      poolPct: 30,
      carryInPaise: 900,
      loanCounts: new Map([["a", 4]]),
    });
    expect(out).toMatchObject({ poolPaise: 900, perLoanPaise: 225, carryOutPaise: 0 });
  });

  it("per-lender credits sum to per_loan x loans exactly", () => {
    const counts = new Map([
      ["a", 3],
      ["b", 5],
      ["c", 1],
      ["d", 0],
    ]);
    const out = computePool({
      revenuePaise: 987654,
      poolPct: 30,
      carryInPaise: 17,
      loanCounts: counts,
    });
    const sum = out.credits.reduce((s, c) => s + c.creditPaise, 0);
    expect(sum).toBe(out.perLoanPaise * out.loanCount);
    expect(out.credits.find((c) => c.memberId === "d")).toBeUndefined();
  });

  it("rejects bad input", () => {
    expect(() =>
      computePool({ revenuePaise: -1, poolPct: 30, carryInPaise: 0, loanCounts: new Map() }),
    ).toThrow(RangeError);
    expect(() =>
      computePool({ revenuePaise: 1, poolPct: 101, carryInPaise: 0, loanCounts: new Map() }),
    ).toThrow(RangeError);
  });
});

describe("runPool and payouts (db)", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const NOW = new Date("2026-09-21T10:00:00Z");
  const config = CONFIG_DEFAULTS;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seed(db, { now: NOW });
    // The seed already ran August's pool. Remove it so we can run it ourselves and compare.
    await db.delete(ledgerEntries).where(eq(ledgerEntries.kind, "pool_credit"));
    await db.delete(payouts);
    await db.delete(poolRuns);
    await db.execute(
      sql`update members m set payout_balance_paise = coalesce((select sum(amount_paise) from ledger_entries e where e.member_id = m.id and e.account = 'payout'), 0)`,
    );
  }, 60_000);
  afterAll(() => close());

  it("runs the previous month, credits lenders, and is idempotent", async () => {
    const month = new Date("2026-08-01T00:00:00Z");
    const first = await runPool(db, month, config, NOW);
    expect(first.status).toBe("created");
    const s = first.statement;
    expect(s.loanCount).toBeGreaterThanOrEqual(5); // 5 returned + 1 resolved seeded in August
    expect(s.poolPaise).toBe(Math.floor((s.revenuePaise * 30) / 100));
    expect(s.perLoanPaise * s.loanCount + s.carryOutPaise).toBe(s.poolPaise);

    const credits = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.kind, "pool_credit"));
    expect(credits.reduce((a, c) => a + c.amountPaise, 0)).toBe(s.perLoanPaise * s.loanCount);
    for (const lender of s.lenders) {
      const [m] = await db
        .select({ payout: members.payoutBalancePaise })
        .from(members)
        .where(eq(members.id, lender.memberId));
      const others = await db
        .select({ sum: sql<number>`coalesce(sum(amount_paise),0)` })
        .from(ledgerEntries)
        .where(
          sql`${ledgerEntries.memberId} = ${lender.memberId} and ${ledgerEntries.account} = 'payout' and ${ledgerEntries.kind} <> 'pool_credit'`,
        );
      expect(m.payout).toBe(lender.creditPaise + Number(others[0].sum));
    }

    const second = await runPool(db, month, config, NOW);
    expect(second.status).toBe("exists");
    expect(second.poolRunId).toBe(first.poolRunId);
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.kind, "pool_credit")),
    ).toHaveLength(credits.length);
  });

  it("carries the remainder into the next month", async () => {
    const [aug] = await db
      .select()
      .from(poolRuns)
      .where(eq(poolRuns.month, new Date("2026-08-01T00:00:00Z")));
    const sep = await runPool(db, new Date("2026-09-01T00:00:00Z"), config, NOW);
    expect(sep.statement.carryInPaise).toBe(aug.carryOutPaise);
  });

  it("estimates the current month for a lender", async () => {
    const [aug] = await db
      .select()
      .from(poolRuns)
      .where(eq(poolRuns.month, new Date("2026-08-01T00:00:00Z")));
    const lender = aug.statement.lenders[0].memberId;
    const est = await estimateCurrentMonth(db, lender, config, NOW);
    expect(est.month).toBe("2026-09-01");
    expect(est.estimatePaise).toBe(est.perLoanPaise * est.myLoans);
  });

  it("generates a payout batch for verified-UPI members above the threshold, exports CSV, and settles", async () => {
    const [aug] = await db
      .select()
      .from(poolRuns)
      .where(eq(poolRuns.month, new Date("2026-08-01T00:00:00Z")));
    // Ensure at least one eligible member.
    const lender = aug.statement.lenders[0].memberId;
    await db
      .update(members)
      .set({ upiId: "test@upi", upiVerified: true, payoutBalancePaise: 25000 })
      .where(eq(members.id, lender));
    await db.insert(ledgerEntries).values({
      memberId: lender,
      account: "payout",
      kind: "adjustment",
      amountPaise: 25000 - aug.statement.lenders[0].creditPaise,
      note: "test top-up",
    });

    const batch = await generatePayoutBatch(db, aug.id, config, NOW);
    expect(batch.created).toBeGreaterThan(0);
    expect(
      batch.payouts.every(
        (p) => p.amountPaise >= config.payout_threshold_paise && p.status === "pending",
      ),
    ).toBe(true);
    const again = await generatePayoutBatch(db, aug.id, config, NOW);
    expect(again.created).toBe(0);
    expect(again.payouts).toHaveLength(batch.payouts.length);

    const csv = payoutBatchCsv(batch.payouts);
    expect(csv.split("\n")[0]).toContain("Fund Account Vpa");
    expect(csv).toContain("test@upi");
    expect(csv).toContain((25000 / 100).toFixed(2));
    expect(await markBatchExported(db, batch.batchId, NOW)).toBe(batch.payouts.length);

    const mine = batch.payouts.find((p) => p.memberId === lender)!;
    const [admin] = await db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.isAdmin, true));
    const res = await markPayoutResult(
      db,
      {
        payoutId: mine.id,
        result: "paid",
        razorpayPayoutId: "pout_1",
        adminId: admin.id,
        reason: "RazorpayX batch confirmed",
      },
      NOW,
    );
    expect(res.ok).toBe(true);
    const [m] = await db
      .select({ payout: members.payoutBalancePaise })
      .from(members)
      .where(eq(members.id, lender));
    expect(m.payout).toBe(0);
    expect(
      await markPayoutResult(
        db,
        { payoutId: mine.id, result: "paid", adminId: admin.id, reason: "again" },
        NOW,
      ),
    ).toEqual({ ok: false, error: "already_settled" });
  });
});
