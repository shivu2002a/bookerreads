import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  books,
  clusters,
  copies,
  disputes,
  dropPoints,
  events,
  ledgerEntries,
  loanPhotos,
  members,
  notifications,
  plans,
  trustEvents,
} from "@/db/schema";
import { CONFIG_DEFAULTS } from "@/lib/config/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { applyLoanEvent, createLoanRequest } from "./persist";
import type { Actor } from "./types";

const NOW = new Date("2026-09-21T10:00:00Z");
const H = 3_600_000;
const D = 24 * H;

let db: TestDb;
let close: () => Promise<void>;
let clusterId: string;
let planId: string;
let lender: string;
let borrower: string;
let borrower2: string;
let admin: string;
let dropPointId: string;
let bookId: string;

const config = CONFIG_DEFAULTS;
const member = (id: string): Actor => ({ kind: "member", memberId: id, isAdmin: false });
const adminActor = (): Actor => ({ kind: "member", memberId: admin, isAdmin: true });
const system: Actor = { kind: "system" };
const at = (d: Date) => ({ now: () => d, newHandoffCode: () => "ABC234" });

async function activeMember(
  name: string,
  phoneHash: string,
  extra: Partial<typeof members.$inferInsert> = {},
) {
  const [m] = await db
    .insert(members)
    .values({
      authUserId: crypto.randomUUID(),
      phoneHash,
      displayName: name,
      clusterId,
      state: "active",
      planId,
      depositBalancePaise: 75000,
      trustScore: 60,
      firstBorrowCompletedAt: new Date("2026-01-01"),
      createdAt: new Date("2026-01-01"),
      ...extra,
    })
    .returning();
  await db
    .insert(ledgerEntries)
    .values({ memberId: m.id, account: "deposit", kind: "deposit_in", amountPaise: 75000 });
  // Borrow gate: three listed copies, one verified.
  for (let i = 0; i < 3; i++) {
    await db.insert(copies).values({
      bookId,
      ownerId: m.id,
      clusterId,
      condition: "good",
      replacementValuePaise: 30000,
      listingPhotoPath: `p/${m.id}/${i}.jpg`,
      allowedHandoffs: ["meetup", "drop_point"],
      verificationStatus: i === 0 ? "verified" : "unverified",
    });
  }
  return m.id;
}

async function newCopy(ownerId: string, over: Partial<typeof copies.$inferInsert> = {}) {
  const [c] = await db
    .insert(copies)
    .values({
      bookId,
      ownerId,
      clusterId,
      condition: "good",
      replacementValuePaise: 49900,
      listingPhotoPath: "p/x.jpg",
      allowedHandoffs: ["meetup", "drop_point"],
      ...over,
    })
    .returning();
  return c;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [{ id: clusterId }] = await db
    .insert(clusters)
    .values({ slug: "ce", name: "CE", pincodes: [], status: "open" })
    .returning({ id: clusters.id });
  [{ id: planId }] = await db
    .insert(plans)
    .values({
      code: "regular",
      name: "Regular",
      pricePaise: 24900,
      concurrentLimit: 2,
      loanPeriodDays: 21,
    })
    .returning({ id: plans.id });
  [{ id: bookId }] = await db
    .insert(books)
    .values({
      isbn13: "9780062316097",
      title: "Sapiens",
      authors: ["Harari"],
      source: "google_books",
    })
    .returning({ id: books.id });
  [{ id: dropPointId }] = await db
    .insert(dropPoints)
    .values({
      clusterId,
      name: "DP",
      address: "a",
      contact: "c",
      hours: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
      capacity: 2,
      qrSecret: "s",
    })
    .returning({ id: dropPoints.id });
  lender = await activeMember("Lender", "l");
  borrower = await activeMember("Borrower", "b");
  borrower2 = await activeMember("Borrower2", "b2");
  admin = await activeMember("Admin", "a", { isAdmin: true });
});
afterAll(() => close());

describe("createLoanRequest", () => {
  it("creates the loan, marks the copy requested, queues a notification, writes an event", async () => {
    const copy = await newCopy(lender);
    const res = await createLoanRequest(
      db,
      { copyId: copy.id, borrowerId: borrower, handoffMethod: "meetup" },
      member(borrower),
      config,
      at(NOW),
    );
    expect(res.ok, res.ok ? "" : res.error.message).toBe(true);
    if (!res.ok) return;
    expect(res.loan.state).toBe("requested");
    const [c] = await db.select().from(copies).where(eq(copies.id, copy.id));
    expect(c.availability).toBe("requested");
    const n = await db.select().from(notifications).where(eq(notifications.loanId, res.loan.id));
    expect(n).toEqual([
      expect.objectContaining({ memberId: lender, template: "request_received", status: "queued" }),
    ]);
    const ev = await db.select().from(events).where(eq(events.aggregateId, res.loan.id));
    expect(ev.map((e) => e.type)).toEqual(["loan.requested"]);
  });

  it("refuses when the borrower fails a guard, without writing anything", async () => {
    const copy = await newCopy(lender, { minBorrowerTrust: 70 });
    const before = await db.select({ n: sql<number>`count(*)` }).from(events);
    const res = await createLoanRequest(
      db,
      { copyId: copy.id, borrowerId: borrower, handoffMethod: "meetup" },
      member(borrower),
      config,
      at(NOW),
    );
    expect(!res.ok && res.error.code).toBe("trust_below_copy_min");
    const after = await db.select({ n: sql<number>`count(*)` }).from(events);
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    const [c] = await db.select().from(copies).where(eq(copies.id, copy.id));
    expect(c.availability).toBe("available");
  });

  it("exactly one of two concurrent requests for the same copy succeeds", async () => {
    const copy = await newCopy(lender);
    const [a, b] = await Promise.all([
      createLoanRequest(
        db,
        { copyId: copy.id, borrowerId: borrower, handoffMethod: "meetup" },
        member(borrower),
        config,
        at(NOW),
      ),
      createLoanRequest(
        db,
        { copyId: copy.id, borrowerId: borrower2, handoffMethod: "meetup" },
        member(borrower2),
        config,
        at(NOW),
      ),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    if (!fails[0].ok) expect(fails[0].error.code).toBe("copy_unavailable");
  });

  it("enforces the plan's concurrent limit", async () => {
    const heavy = await activeMember("Heavy", "h");
    const c1 = await newCopy(lender);
    const c2 = await newCopy(lender);
    const c3 = await newCopy(lender);
    expect(
      (
        await createLoanRequest(
          db,
          { copyId: c1.id, borrowerId: heavy, handoffMethod: "meetup" },
          member(heavy),
          config,
          at(NOW),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await createLoanRequest(
          db,
          { copyId: c2.id, borrowerId: heavy, handoffMethod: "meetup" },
          member(heavy),
          config,
          at(NOW),
        )
      ).ok,
    ).toBe(true);
    const third = await createLoanRequest(
      db,
      { copyId: c3.id, borrowerId: heavy, handoffMethod: "meetup" },
      member(heavy),
      config,
      at(NOW),
    );
    expect(!third.ok && third.error.code).toBe("at_concurrent_limit");
  });
});

describe("full lifecycle", () => {
  it("request -> accept -> handoff x2 -> return x2 leaves everything consistent", async () => {
    const borrower = await activeMember("Lifecycle", "lc");
    const copy = await newCopy(lender);
    const req = await createLoanRequest(
      db,
      { copyId: copy.id, borrowerId: borrower, handoffMethod: "meetup" },
      member(borrower),
      config,
      at(NOW),
    );
    if (!req.ok) throw new Error(req.error.message);
    const id = req.loan.id;

    const acc = await applyLoanEvent(
      db,
      id,
      { type: "accept", inHandConfirmed: true },
      member(lender),
      config,
      at(new Date(NOW.getTime() + 1 * H)),
    );
    expect(acc.ok && acc.loan.state).toBe("accepted");

    const t1 = new Date(NOW.getTime() + 1 * D);
    const o1 = await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", photoPath: "loans/out-l.jpg" },
      member(lender),
      config,
      at(t1),
    );
    expect(o1.ok && o1.loan.state).toBe("accepted");
    const o2 = await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", photoPath: "loans/out-b.jpg" },
      member(borrower),
      config,
      at(t1),
    );
    expect(o2.ok && o2.loan.state).toBe("on_loan");
    expect(o2.ok && o2.loan.dueAt).toEqual(new Date(t1.getTime() + 21 * D));
    let [c] = await db.select().from(copies).where(eq(copies.id, copy.id));
    expect(c.availability).toBe("on_loan");

    // Replaying a confirmation (offline outbox) is refused cleanly, not applied twice.
    const replay = await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", photoPath: "loans/out-b.jpg" },
      member(borrower),
      config,
      at(t1),
    );
    expect(!replay.ok && replay.error.code).toBe("invalid_transition");

    const t2 = new Date(t1.getTime() + 10 * D);
    const r1 = await applyLoanEvent(
      db,
      id,
      { type: "confirm_return", photoPath: "loans/ret-b.jpg" },
      member(borrower),
      config,
      at(t2),
    );
    expect(r1.ok && r1.loan.state).toBe("on_loan");
    const r2 = await applyLoanEvent(
      db,
      id,
      { type: "confirm_return", photoPath: "loans/ret-l.jpg", condition: "good" },
      member(lender),
      config,
      at(t2),
    );
    expect(r2.ok && r2.loan.state).toBe("returned");
    expect(r2.ok && r2.loan.poolMonth).toEqual(new Date("2026-10-01"));

    [c] = await db.select().from(copies).where(eq(copies.id, copy.id));
    expect(c.availability).toBe("available");
    expect(c.verificationStatus).toBe("verified");
    expect(c.declineCount).toBe(0);

    const photos = await db.select().from(loanPhotos).where(eq(loanPhotos.loanId, id));
    expect(photos.map((p) => `${p.phase}:${p.takenBy === lender ? "L" : "B"}`).sort()).toEqual([
      "out:B",
      "out:L",
      "return:B",
      "return:L",
    ]);

    const te = await db.select().from(trustEvents).where(eq(trustEvents.loanId, id));
    expect(te.map((t) => t.kind).sort()).toEqual([
      "borrow_completed",
      "lend_completed",
      "return_on_time",
    ]);
    const [b] = await db.select().from(members).where(eq(members.id, borrower));
    expect(b.trustScore).toBe(50 + 2 + 1 + Math.min(6, 8)); // base + on-time + borrow_completed + age bonus (Jan->Oct, capped at 6)

    const ev = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, id))
      .orderBy(events.createdAt);
    expect(ev.map((e) => e.type)).toEqual([
      "loan.requested",
      "loan.accepted",
      "loan.handoff_confirmed",
      "loan.on_loan",
      "loan.return_confirmed",
      "loan.returned",
    ]);
  });

  it("drop-point handoff tracks occupancy and refuses a wrong code", async () => {
    const borrower = await activeMember("Dropper", "dr");
    const copy = await newCopy(lender);
    const req = await createLoanRequest(
      db,
      { copyId: copy.id, borrowerId: borrower, handoffMethod: "drop_point", dropPointId },
      member(borrower),
      config,
      at(NOW),
    );
    if (!req.ok) throw new Error(req.error.message);
    const id = req.loan.id;
    const acc = await applyLoanEvent(
      db,
      id,
      { type: "accept", inHandConfirmed: true },
      member(lender),
      config,
      at(NOW),
    );
    expect(acc.ok && acc.loan.handoffCode).toBe("ABC234");

    expect(
      (
        await applyLoanEvent(
          db,
          id,
          { type: "confirm_out", code: "NOPE22" },
          member(lender),
          config,
          at(NOW),
        )
      ).ok,
    ).toBe(false);
    const dropped = await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", code: "abc234" },
      member(lender),
      config,
      at(NOW),
    );
    expect(dropped.ok).toBe(true);
    let [dp] = await db.select().from(dropPoints).where(eq(dropPoints.id, dropPointId));
    expect(dp.occupancy).toBe(1);

    const collected = await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", code: "ABC234" },
      member(borrower),
      config,
      at(NOW),
    );
    expect(collected.ok && collected.loan.state).toBe("on_loan");
    [dp] = await db.select().from(dropPoints).where(eq(dropPoints.id, dropPointId));
    expect(dp.occupancy).toBe(0);
  });
});

describe("lost book", () => {
  it("charges the deposit, credits the lender, suspends the borrower, and flags top-up", async () => {
    const victim = await activeMember("Victim", "v");
    const copy = await newCopy(lender, { replacementValuePaise: 60000 });
    const req = await createLoanRequest(
      db,
      { copyId: copy.id, borrowerId: victim, handoffMethod: "meetup" },
      member(victim),
      config,
      at(NOW),
    );
    if (!req.ok) throw new Error(req.error.message);
    const id = req.loan.id;
    await applyLoanEvent(
      db,
      id,
      { type: "accept", inHandConfirmed: true },
      member(lender),
      config,
      at(NOW),
    );
    await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", photoPath: "a" },
      member(lender),
      config,
      at(NOW),
    );
    await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", photoPath: "b" },
      member(victim),
      config,
      at(NOW),
    );
    const due = new Date(NOW.getTime() + 21 * D);
    expect(
      (
        await applyLoanEvent(
          db,
          id,
          { type: "overdue_tick" },
          system,
          config,
          at(new Date(due.getTime() + 1 * H)),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await applyLoanEvent(
          db,
          id,
          { type: "lost_tick" },
          system,
          config,
          at(new Date(due.getTime() + 13 * D)),
        )
      ).ok,
    ).toBe(false);
    const lost = await applyLoanEvent(
      db,
      id,
      { type: "lost_tick" },
      system,
      config,
      at(new Date(due.getTime() + 15 * D)),
    );
    expect(lost.ok && lost.loan.state).toBe("lost");

    const [v] = await db.select().from(members).where(eq(members.id, victim));
    // Deposit was 75000; replacement 60000 -> 15000 left, below the required 75000.
    expect(v.depositBalancePaise).toBe(15000);
    expect(v.needsTopup).toBe(true);
    expect(v.state).toBe("suspended");
    expect(v.suspendedUntil).toEqual(new Date(due.getTime() + 15 * D + 90 * D));
    const [l] = await db.select().from(members).where(eq(members.id, lender));
    expect(l.payoutBalancePaise).toBe(60000);
    const [c] = await db.select().from(copies).where(eq(copies.id, copy.id));
    expect(c.availability).toBe("lost");
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.loanId, id));
    expect(entries.map((e) => `${e.kind}:${e.amountPaise}`).sort()).toEqual([
      "deposit_charge:-60000",
      "lost_book_credit:60000",
    ]);
  });

  it("clamps a charge larger than the deposit and records the shortfall", async () => {
    const poor = await activeMember("Poor", "p", { depositBalancePaise: 20000 });
    await db
      .update(ledgerEntries)
      .set({ amountPaise: 20000 })
      .where(eq(ledgerEntries.memberId, poor));
    const copy = await newCopy(lender, { replacementValuePaise: 50000 });
    // Deposit 20000 < required: activation fails. Grant the deposit level for the request, then lower it.
    await db.update(members).set({ depositBalancePaise: 75000 }).where(eq(members.id, poor));
    const req = await createLoanRequest(
      db,
      { copyId: copy.id, borrowerId: poor, handoffMethod: "meetup" },
      member(poor),
      config,
      at(NOW),
    );
    if (!req.ok) throw new Error(req.error.message);
    await db.update(members).set({ depositBalancePaise: 20000 }).where(eq(members.id, poor));
    const id = req.loan.id;
    await applyLoanEvent(
      db,
      id,
      { type: "accept", inHandConfirmed: true },
      member(lender),
      config,
      at(NOW),
    );
    await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", photoPath: "a" },
      member(lender),
      config,
      at(NOW),
    );
    await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", photoPath: "b" },
      member(poor),
      config,
      at(NOW),
    );
    const due = new Date(NOW.getTime() + 21 * D);
    await applyLoanEvent(
      db,
      id,
      { type: "overdue_tick" },
      system,
      config,
      at(new Date(due.getTime() + 1 * H)),
    );
    const lost = await applyLoanEvent(
      db,
      id,
      { type: "lost_tick" },
      system,
      config,
      at(new Date(due.getTime() + 15 * D)),
    );
    expect(lost.ok).toBe(true);
    const [p] = await db.select().from(members).where(eq(members.id, poor));
    expect(p.depositBalancePaise).toBe(0);
    const shortfall = await db
      .select()
      .from(events)
      .where(sql`${events.aggregateId} = ${id} and ${events.type} = 'ledger.deposit_shortfall'`);
    expect(shortfall).toHaveLength(1);
    expect((shortfall[0].payload as { shortfallPaise: number }).shortfallPaise).toBe(30000);
    // Lender is still credited in full.
    const credit = await db
      .select()
      .from(ledgerEntries)
      .where(sql`${ledgerEntries.loanId} = ${id} and ${ledgerEntries.kind} = 'lost_book_credit'`);
    expect(credit[0].amountPaise).toBe(50000);
  });
});

describe("dispute", () => {
  it("opens and resolves with a partial charge", async () => {
    const copy = await newCopy(lender, { replacementValuePaise: 40000 });
    const req = await createLoanRequest(
      db,
      { copyId: copy.id, borrowerId: borrower2, handoffMethod: "meetup" },
      member(borrower2),
      config,
      at(NOW),
    );
    if (!req.ok) throw new Error(req.error.message);
    const id = req.loan.id;
    await applyLoanEvent(
      db,
      id,
      { type: "accept", inHandConfirmed: true },
      member(lender),
      config,
      at(NOW),
    );
    await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", photoPath: "a" },
      member(lender),
      config,
      at(NOW),
    );
    await applyLoanEvent(
      db,
      id,
      { type: "confirm_out", photoPath: "b" },
      member(borrower2),
      config,
      at(NOW),
    );
    const t = new Date(NOW.getTime() + 5 * D);
    await applyLoanEvent(
      db,
      id,
      { type: "confirm_return", photoPath: "rb" },
      member(borrower2),
      config,
      at(t),
    );
    await applyLoanEvent(
      db,
      id,
      { type: "confirm_return", photoPath: "rl", condition: "worn" },
      member(lender),
      config,
      at(t),
    );

    const disputed = await applyLoanEvent(
      db,
      id,
      { type: "dispute", reason: "Spine cracked, pages loose." },
      member(lender),
      config,
      at(new Date(t.getTime() + 2 * H)),
    );
    expect(disputed.ok && disputed.loan.state).toBe("disputed");
    const [d] = await db.select().from(disputes).where(eq(disputes.loanId, id));
    expect(d).toMatchObject({ state: "open", openedBy: lender });
    const adminNotes = await db
      .select()
      .from(notifications)
      .where(sql`${notifications.loanId} = ${id} and ${notifications.memberId} = ${admin}`);
    expect(adminNotes.some((n) => n.template === "dispute_opened")).toBe(true);

    expect(
      (
        await applyLoanEvent(
          db,
          id,
          { type: "resolve", resolution: "partial_charge", chargePaise: 10000, note: "x" },
          member(lender),
          config,
          at(t),
        )
      ).ok,
    ).toBe(false);
    const resolved = await applyLoanEvent(
      db,
      id,
      { type: "resolve", resolution: "partial_charge", chargePaise: 10000, note: "Cover repair." },
      adminActor(),
      config,
      at(new Date(t.getTime() + 1 * D)),
    );
    expect(resolved.ok && resolved.loan.state).toBe("resolved");
    const [d2] = await db.select().from(disputes).where(eq(disputes.loanId, id));
    expect(d2).toMatchObject({
      state: "resolved",
      resolution: "partial_charge",
      chargePaise: 10000,
      resolvedBy: admin,
    });
    const [b2] = await db.select().from(members).where(eq(members.id, borrower2));
    expect(b2.depositBalancePaise).toBe(65000);
    expect(b2.needsTopup).toBe(true);
  });
});
