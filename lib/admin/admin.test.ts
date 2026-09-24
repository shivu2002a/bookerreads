import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminActions, books, clusters, copies, loans, members } from "@/db/schema";
import { seed } from "@/db/seed/run";
import { CONFIG_DEFAULTS } from "@/lib/config/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { adminAction, AdminReasonRequired } from "./act";
import { editBook, mergeBooks } from "./catalogue";
import { createDropPoint, rotateDropPointSecret } from "./drop-points";
import { clusterHealth } from "./health";
import { overrideLoanState, searchLoans } from "./loans";
import {
  adjustDeposit,
  openCluster,
  reinstateMember,
  searchMembers,
  suspendMember,
} from "./members";

let db: TestDb;
let close: () => Promise<void>;
let admin: string;
let clusterId: string;
const NOW = new Date("2026-09-21T10:00:00Z");
const actionCount = async () =>
  Number((await db.select({ n: sql<number>`count(*)` }).from(adminActions))[0].n);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seed(db, { now: NOW });
  [{ id: admin }] = await db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.isAdmin, true));
  [{ id: clusterId }] = await db
    .select({ id: clusters.id })
    .from(clusters)
    .where(eq(clusters.slug, "central-east"));
});
afterAll(() => close());

describe("adminAction", () => {
  it("refuses an empty reason and writes nothing", async () => {
    const before = await actionCount();
    await expect(
      adminAction(
        db,
        {
          adminId: admin,
          target: { type: "x", id: crypto.randomUUID() },
          action: "x",
          reason: "  ",
        },
        async () => 1,
      ),
    ).rejects.toBeInstanceOf(AdminReasonRequired);
    expect(await actionCount()).toBe(before);
  });

  it("rolls the log row back when the mutation throws", async () => {
    const before = await actionCount();
    await expect(
      adminAction(
        db,
        {
          adminId: admin,
          target: { type: "x", id: crypto.randomUUID() },
          action: "x",
          reason: "testing",
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(await actionCount()).toBe(before);
  });

  it("writes exactly one row on success", async () => {
    const before = await actionCount();
    await adminAction(
      db,
      {
        adminId: admin,
        target: { type: "x", id: crypto.randomUUID() },
        action: "x",
        reason: "testing",
      },
      async () => 1,
    );
    expect(await actionCount()).toBe(before + 1);
  });
});

describe("members", () => {
  it("finds by display name and by phone number", async () => {
    expect((await searchMembers(db, "ananya")).map((m) => m.displayName)).toEqual(["Ananya"]);
    expect((await searchMembers(db, "+91 99999 00002")).map((m) => m.displayName)).toEqual([
      "Rohan",
    ]);
    expect(await searchMembers(db, "9999900099")).toEqual([]);
  });

  it("suspends and reinstates with logged reasons", async () => {
    const [m] = await db.select().from(members).where(eq(members.displayName, "Rohan"));
    await suspendMember(db, {
      adminId: admin,
      memberId: m.id,
      untilDays: 30,
      reason: "Repeated no-shows",
    });
    let [after] = await db.select().from(members).where(eq(members.id, m.id));
    expect(after.state).toBe("suspended");
    expect(after.suspendedUntil).not.toBeNull();
    await reinstateMember(db, { adminId: admin, memberId: m.id, reason: "Appeal accepted" });
    [after] = await db.select().from(members).where(eq(members.id, m.id));
    expect(after.state).toBe("active");
    const log = await db.select().from(adminActions).where(eq(adminActions.targetId, m.id));
    expect(log.map((l) => l.action)).toEqual(["member.suspend", "member.reinstate"]);
  });

  it("deposit adjustment posts a ledger row and updates the top-up flag", async () => {
    const [m] = await db.select().from(members).where(eq(members.displayName, "Nikhil")); // lost a book; below deposit
    expect(m.needsTopup).toBe(true);
    await adjustDeposit(
      db,
      {
        adminId: admin,
        memberId: m.id,
        amountPaise: CONFIG_DEFAULTS.deposit_paise - m.depositBalancePaise,
        reason: "Goodwill after dispute",
      },
      CONFIG_DEFAULTS,
    );
    const [after] = await db.select().from(members).where(eq(members.id, m.id));
    expect(after.depositBalancePaise).toBe(CONFIG_DEFAULTS.deposit_paise);
    expect(after.needsTopup).toBe(false);
  });

  it("opening a cluster notifies its waitlist once", async () => {
    const [south] = await db.select().from(clusters).where(eq(clusters.slug, "south"));
    expect(
      await openCluster(db, { adminId: admin, clusterId: south.id, reason: "Hit 60 members" }),
    ).toBe(1);
    expect(await openCluster(db, { adminId: admin, clusterId: south.id, reason: "again" })).toBe(0);
  });
});

describe("loans", () => {
  it("searches by title and by id", async () => {
    const [l] = await db.select().from(loans).limit(1);
    expect((await searchLoans(db, l.id)).map((r) => r.id)).toEqual([l.id]);
    const byTitle = await searchLoans(db, "harry");
    expect(byTitle.every((r) => /harry/i.test(r.title))).toBe(true);
  });

  it("override keeps the copy consistent and refuses to double-book a copy", async () => {
    const [l] = await db.select().from(loans).where(eq(loans.state, "on_loan")).limit(1);
    const res = await overrideLoanState(db, {
      adminId: admin,
      loanId: l.id,
      toState: "returned",
      reason: "Both parties confirmed by phone",
    });
    expect(res).toEqual({ ok: true });
    const [copy] = await db.select().from(copies).where(eq(copies.id, l.copyId));
    expect(copy.availability).toBe("available");
    const [after] = await db.select().from(loans).where(eq(loans.id, l.id));
    expect(after.returnedAt).not.toBeNull();

    // Another loan now holds the copy; reopening the old one must fail.
    const [{ id: other }] = await db
      .insert(loans)
      .values({
        copyId: l.copyId,
        bookId: l.bookId,
        lenderId: l.lenderId,
        borrowerId: l.borrowerId,
        state: "requested",
        handoffMethod: "meetup",
      })
      .returning({ id: loans.id });
    const bad = await overrideLoanState(db, {
      adminId: admin,
      loanId: l.id,
      toState: "on_loan",
      reason: "oops",
    });
    expect(bad.ok).toBe(false);
    await db.delete(loans).where(eq(loans.id, other));
  });
});

describe("catalogue", () => {
  it("merge repoints copies and loans, leaves no orphans, and redirects the duplicate", async () => {
    const [dupe] = await db.select().from(books).where(eq(books.needsReview, true)).limit(1);
    const [survivor] = await db
      .select()
      .from(books)
      .where(sql`${books.isbn13} is not null`)
      .limit(1);
    const [{ n: before }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(copies)
      .where(eq(copies.bookId, survivor.id));
    // Give the dupe a copy so there is something to move.
    const [owner] = await db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.state, "active"))
      .limit(1);
    await db.insert(copies).values({
      bookId: dupe.id,
      ownerId: owner.id,
      clusterId,
      condition: "good",
      replacementValuePaise: 30000,
      listingPhotoPath: "p",
      allowedHandoffs: ["meetup"],
    });
    const res = await mergeBooks(db, {
      adminId: admin,
      duplicateId: dupe.id,
      survivorId: survivor.id,
      reason: "Same edition",
    });
    expect(res).toEqual({ ok: true, movedCopies: 1 });
    expect(await db.select().from(copies).where(eq(copies.bookId, dupe.id))).toHaveLength(0);
    const [{ n: after }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(copies)
      .where(eq(copies.bookId, survivor.id));
    expect(Number(after)).toBe(Number(before) + 1);
    const [d] = await db.select().from(books).where(eq(books.id, dupe.id));
    expect(d.mergedIntoId).toBe(survivor.id);
    expect(d.needsReview).toBe(false);
    expect(
      (
        await mergeBooks(db, {
          adminId: admin,
          duplicateId: survivor.id,
          survivorId: dupe.id,
          reason: "x",
        })
      ).ok,
    ).toBe(false);
  });

  it("approve clears needs_review and rejects a clashing ISBN", async () => {
    const [b] = await db.select().from(books).where(eq(books.needsReview, true)).limit(1);
    const [other] = await db
      .select()
      .from(books)
      .where(sql`${books.isbn13} is not null`)
      .limit(1);
    const clash = await editBook(db, {
      adminId: admin,
      bookId: b.id,
      reason: "x",
      approve: true,
      data: {
        title: b.title,
        authors: b.authors,
        isbn13: other.isbn13!,
        publisher: "",
        publishedYear: null,
        language: "en",
        listPricePaise: null,
      },
    });
    expect(clash.ok).toBe(false);
    const ok = await editBook(db, {
      adminId: admin,
      bookId: b.id,
      reason: "Checked title page",
      approve: true,
      data: {
        title: b.title,
        authors: b.authors,
        isbn13: "",
        publisher: "Penguin",
        publishedYear: 2015,
        language: "en",
        listPricePaise: 39900,
      },
    });
    expect(ok).toEqual({ ok: true });
    const [after] = await db.select().from(books).where(eq(books.id, b.id));
    expect(after.needsReview).toBe(false);
    expect(after.publisher).toBe("Penguin");
  });
});

describe("drop points and health", () => {
  it("creates a drop point with a secret and can rotate it", async () => {
    const hours = {
      mon: null,
      tue: { open: "10:00", close: "20:00" },
      wed: null,
      thu: null,
      fri: null,
      sat: null,
      sun: null,
    };
    const id = await createDropPoint(db, {
      adminId: admin,
      reason: "New partner",
      clusterId,
      name: "Cafe Zed",
      address: "12 Main Rd",
      contact: "x",
      capacity: 10,
      hours,
      active: true,
    });
    const [{ dp }] = await import("./drop-points")
      .then((m) => m.listDropPoints(db))
      .then((rows) => rows.filter((r) => r.dp.id === id));
    expect(dp.qrSecret).toHaveLength(32);
    await rotateDropPointSecret(db, { adminId: admin, id, reason: "Poster leaked" });
    const [{ dp: after }] = await import("./drop-points")
      .then((m) => m.listDropPoints(db))
      .then((rows) => rows.filter((r) => r.dp.id === id));
    expect(after.qrSecret).not.toBe(dp.qrSecret);
  });

  it("computes cluster health metrics", async () => {
    const h = await clusterHealth(db, clusterId, NOW);
    expect(Object.values(h.membersByState).reduce((a, b) => a + b, 0)).toBe(30);
    expect(h.copiesByAvailability.available).toBeGreaterThan(0);
    expect(h.depositLiabilityPaise).toBeGreaterThan(0);
    expect(
      h.onTimeReturnRate === null || (h.onTimeReturnRate >= 0 && h.onTimeReturnRate <= 1),
    ).toBe(true);
    expect(h.medianRequestToHandoffHours === null || h.medianRequestToHandoffHours > 0).toBe(true);
  });
});
