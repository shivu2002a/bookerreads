import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { loanState } from "../schema";
import { seed, type SeedSummary } from "./run";

let db: TestDb;
let close: () => Promise<void>;
let summary: SeedSummary;
const NOW = new Date("2026-09-21T10:00:00Z");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  summary = await seed(db, { now: NOW });
}, 60_000);
afterAll(() => close());

const count = async (table: string, where = "true") => {
  const r = await db.execute<{ n: string }>(
    sql.raw(`select count(*)::text as n from ${table} where ${where}`),
  );
  return Number(r.rows[0].n);
};

describe("seed", () => {
  it("produces the volumes the plan asks for", async () => {
    expect(summary.clusters).toBe(3);
    expect(await count("clusters", "status = 'open'")).toBe(1);
    expect(summary.plans).toBe(3);
    expect(summary.dropPoints).toBe(2);
    expect(await count("books")).toBe(202); // 200 fixture + 2 manual
    expect(summary.members).toBe(30);
    expect(summary.copies).toBe(300);
    expect(await count("config")).toBeGreaterThanOrEqual(20);
  });

  it("has at least one loan in every state", () => {
    for (const state of loanState.enumValues) {
      expect(summary.loans[state], `state ${state}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps copy availability consistent with loan state", async () => {
    // Open loans hold their copy in requested/on_loan; closed loans free it.
    expect(
      await count(
        "loans l join copies c on c.id = l.copy_id",
        "l.state in ('requested','accepted') and c.availability <> 'requested'",
      ),
    ).toBe(0);
    expect(
      await count(
        "loans l join copies c on c.id = l.copy_id",
        "l.state in ('on_loan','overdue') and c.availability <> 'on_loan'",
      ),
    ).toBe(0);
    expect(
      await count(
        "loans l join copies c on c.id = l.copy_id",
        "l.state = 'lost' and c.availability <> 'lost'",
      ),
    ).toBe(0);
    expect(
      await count(
        "loans l join copies c on c.id = l.copy_id",
        "l.state in ('returned','disputed','resolved') and c.availability <> 'available'",
      ),
    ).toBe(0);
  });

  it("verifies copies that completed a loan", async () => {
    expect(
      await count(
        "loans l join copies c on c.id = l.copy_id",
        "l.state in ('returned','disputed','resolved') and c.verification_status <> 'verified'",
      ),
    ).toBe(0);
  });

  it("respects the new-account listing cap", async () => {
    const over = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from (
        select m.id from members m join copies c on c.owner_id = m.id
        where m.created_at > ${NOW}::timestamptz - interval '7 days'
        group by m.id having count(*) > 10
      ) x`);
    expect(Number(over.rows[0].n)).toBe(0);
  });

  it("cached balances equal ledger sums", async () => {
    const mismatch = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from members m
      where m.deposit_balance_paise <> coalesce((select sum(amount_paise) from ledger_entries e where e.member_id = m.id and e.account = 'deposit'), 0)
         or m.payout_balance_paise  <> coalesce((select sum(amount_paise) from ledger_entries e where e.member_id = m.id and e.account = 'payout'), 0)`);
    expect(Number(mismatch.rows[0].n)).toBe(0);
  });

  it("holds a full deposit for every paying member except the lost-book borrower", async () => {
    const rows = await db.execute<{
      display_name: string;
      deposit_balance_paise: number;
      needs_topup: boolean;
    }>(sql`
      select display_name, deposit_balance_paise, needs_topup from members
      where plan_id is not null and state in ('active','lapsed','suspended')`);
    const short = rows.rows.filter((r) => Number(r.deposit_balance_paise) < 75000);
    // The suspended member lost a book; the resolved dispute's borrower paid a partial charge.
    expect(short.length).toBe(2);
    for (const r of short) expect(r.needs_topup).toBe(true);
  });

  it("pool run matches the formula over last month's captured revenue and completed loans", async () => {
    const run = await db.execute<{
      revenue_paise: number;
      pool_paise: number;
      loan_count: number;
      per_loan_paise: number;
      carry_out_paise: number;
    }>(
      sql`select revenue_paise, pool_paise, loan_count, per_loan_paise, carry_out_paise from pool_runs`,
    );
    expect(run.rows).toHaveLength(1);
    const r = run.rows[0];
    const revenue = await db.execute<{ sum: string }>(
      sql`select coalesce(sum(amount_paise),0)::text as sum from subscription_payments where status='captured' and pool_month = ${summary.poolRunMonth}::date`,
    );
    expect(Number(r.revenue_paise)).toBe(Number(revenue.rows[0].sum));
    expect(Number(r.pool_paise)).toBe(Math.floor((Number(r.revenue_paise) * 30) / 100));
    expect(Number(r.loan_count)).toBeGreaterThanOrEqual(5);
    expect(Number(r.per_loan_paise) * Number(r.loan_count) + Number(r.carry_out_paise)).toBe(
      Number(r.pool_paise),
    );
    const credits = await db.execute<{ sum: string }>(
      sql`select coalesce(sum(amount_paise),0)::text as sum from ledger_entries where kind='pool_credit'`,
    );
    expect(Number(credits.rows[0].sum)).toBe(Number(r.per_loan_paise) * Number(r.loan_count));
  });

  it("trust scores stay within 0..100 and the lost-book borrower is below 50", async () => {
    expect(await count("members", "trust_score < 0 or trust_score > 100")).toBe(0);
    const s = await db.execute<{ trust_score: number }>(
      sql`select trust_score from members where state = 'suspended'`,
    );
    expect(Number(s.rows[0].trust_score)).toBeLessThan(50);
  });

  it("is idempotent", async () => {
    const again = await seed(db, { now: NOW });
    expect(again.copies).toBe(300);
    expect(await count("members")).toBe(30);
    expect(await count("pool_runs")).toBe(1);
  }, 60_000);
});
