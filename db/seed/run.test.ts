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
      where state in ('active','suspended')`);
    const short = rows.rows.filter((r) => Number(r.deposit_balance_paise) < 50000);
    // The suspended member lost a book; the resolved dispute's borrower paid a partial charge.
    expect(short.length).toBe(2);
    for (const r of short) expect(r.needs_topup).toBe(true);
  });

  it("credits lenders rental minus the 15% fee for every loan that went out", async () => {
    const r = await db.execute<{ expected: string; credited: string; payments: string }>(sql`
      select
        (select coalesce(sum(rental_paise - platform_fee_paise),0)::text from loans where handed_off_at is not null) as expected,
        (select coalesce(sum(amount_paise),0)::text from ledger_entries where kind = 'rental_credit') as credited,
        (select count(*)::text from loan_payments where status = 'captured') as payments`);
    expect(Number(r.rows[0].credited)).toBe(Number(r.rows[0].expected));
    expect(Number(r.rows[0].credited)).toBeGreaterThan(0);
    expect(Number(r.rows[0].payments)).toBe(
      summary.loanPayments - (await count("loan_payments", "status = 'refunded'")),
    );
    expect(
      await count("loans", "state = 'accepted' and paid_at is null and payment_due_at is not null"),
    ).toBe(1);
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
    expect(await count("loan_payments")).toBe(again.loanPayments);
  }, 60_000);
});
