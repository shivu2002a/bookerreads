import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, expectDbError, type TestDb } from "@/test/db";
import * as s from "./schema";

let db: TestDb;
let close: () => Promise<void>;
let seeded: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  seeded = await seedMinimal();
});
afterAll(() => close());

const EXPECTED_TABLES = [
  "clusters",
  "cluster_waitlist",
  "otp_attempts",
  "members",
  "books",
  "copies",
  "drop_points",
  "loans",
  "loan_photos",
  "loan_messages",
  "disputes",
  "ledger_entries",
  "loan_payments",
  "payouts",
  "webhook_events",
  "trust_events",
  "notifications",
  "events",
  "admin_actions",
  "config",
  "cron_runs",
];

async function seedMinimal() {
  const [cluster] = await db
    .insert(s.clusters)
    .values({ slug: "central-east", name: "Central-East", pincodes: ["560038"], status: "open" })
    .returning();
  const [lender, borrower] = await db
    .insert(s.members)
    .values([
      { authUserId: crypto.randomUUID(), phoneHash: "h1", displayName: "L", clusterId: cluster.id },
      { authUserId: crypto.randomUUID(), phoneHash: "h2", displayName: "B", clusterId: cluster.id },
    ])
    .returning();
  const [book] = await db
    .insert(s.books)
    .values({
      isbn13: "9780062316097",
      title: "Sapiens",
      authors: ["Yuval Noah Harari"],
      source: "google_books",
    })
    .returning();
  const [copy] = await db
    .insert(s.copies)
    .values({
      bookId: book.id,
      ownerId: lender.id,
      clusterId: cluster.id,
      condition: "good",
      replacementValuePaise: 49900,
      listingPhotoPath: "p",
      allowedHandoffs: ["meetup"],
    })
    .returning();
  return { cluster, lender, borrower, book, copy };
}

describe("schema migration", () => {
  it("creates every table from design.md", async () => {
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = rows.rows.map((r) => r.table_name).sort();
    for (const t of EXPECTED_TABLES) expect(names).toContain(t);
  });

  it("populates the generated search vector and finds it via full-text search", async () => {
    const hit = await db.execute<{ title: string }>(
      sql`select title from books where search_vector @@ websearch_to_tsquery('simple', 'harari sapiens')`,
    );
    expect(hit.rows.map((r) => r.title)).toEqual(["Sapiens"]);
  });

  it("supports trigram similarity on title (pg_trgm)", async () => {
    const hit = await db.execute<{ title: string }>(
      sql`select title from books where similarity(title, 'Sapeins') > 0.3`,
    );
    expect(hit.rows.map((r) => r.title)).toEqual(["Sapiens"]);
  });

  it("allows at most one open loan per copy", async () => {
    const { lender, borrower, book, copy } = seeded;
    const base = {
      copyId: copy.id,
      bookId: book.id,
      lenderId: lender.id,
      borrowerId: borrower.id,
      handoffMethod: "meetup" as const,
    };
    await db.insert(s.loans).values({ ...base, state: "requested" });
    await expectDbError(
      db.insert(s.loans).values({ ...base, state: "accepted" }),
      "loans_one_open_per_copy_uidx",
    );
    // A closed loan on the same copy is fine.
    await expect(db.insert(s.loans).values({ ...base, state: "returned" })).resolves.toBeDefined();
  });

  it("defaults new members to registered with trust 50 and zero balances", () => {
    const { borrower } = seeded;
    expect(borrower.state).toBe("registered");
    expect(borrower.trustScore).toBe(50);
    expect(borrower.depositBalancePaise).toBe(0);
    expect(borrower.isAdmin).toBe(false);
  });

  it("rejects a second payout for the same member and month", async () => {
    const row = {
      memberId: seeded.lender.id,
      month: new Date("2026-08-01"),
      amountPaise: 25000,
      upiId: "x@upi",
      batchId: "batch_2026-08",
    };
    await db.insert(s.payouts).values(row);
    await expectDbError(db.insert(s.payouts).values(row), "payouts_member_month_uidx");
  });
  it("dedupes provider webhooks by (provider, event id)", async () => {
    const row = {
      provider: "razorpay",
      providerEventId: "evt_1",
      eventType: "payment.captured",
      payload: {},
    };
    await db.insert(s.webhookEvents).values(row);
    await expectDbError(
      db.insert(s.webhookEvents).values(row),
      "webhook_events_provider_event_uidx",
    );
  });
});
