import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { books, clusters, copies, loans, members } from "@/db/schema";
import { CONFIG_DEFAULTS } from "@/lib/config/schema";
import { getPublicProfile } from "@/lib/members/public-profile";
import { createTestDb, type TestDb } from "@/test/db";
import { createCopy, createManualBook } from "./create";
import { listShelf, relistCopy, unlistCopy, updateCopyDetails } from "./manage";
import { clampReplacement, remainingListingAllowance, replacementBounds } from "./rules";

const NOW = new Date("2026-09-21T10:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe("rules", () => {
  it("bounds replacement value to ₹100–₹1000, rounded to rupees", () => {
    expect(replacementBounds(49900)).toEqual({ min: 10000, max: 100000, def: 49900 });
    expect(clampReplacement(1000, 49900)).toBe(10000);
    expect(clampReplacement(250000, 49900)).toBe(100000);
    expect(clampReplacement(50050, 49900)).toBe(50100);
  });

  it("seeds the default from the list price, clamped into the range", () => {
    expect(replacementBounds(null).def).toBe(39900);
    expect(replacementBounds(5000).def).toBe(10000);
    expect(replacementBounds(249900).def).toBe(100000);
  });

  it("caps new accounts at 10 and frees them at 7 days", () => {
    const base = { now: NOW, newAccountAgeDays: 7, cap: 10 };
    expect(
      remainingListingAllowance({ ...base, memberCreatedAt: daysAgo(3), currentCopyCount: 10 }),
    ).toBe(0);
    expect(
      remainingListingAllowance({ ...base, memberCreatedAt: daysAgo(3), currentCopyCount: 4 }),
    ).toBe(6);
    // 6 days 23 h old: still new
    expect(
      remainingListingAllowance({
        ...base,
        memberCreatedAt: new Date(NOW.getTime() - (7 * 24 - 1) * 3600_000),
        currentCopyCount: 10,
      }),
    ).toBe(0);
    // exactly 7 days: no longer new
    expect(
      remainingListingAllowance({ ...base, memberCreatedAt: daysAgo(7), currentCopyCount: 10 }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("copies (db)", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let clusterId: string;
  let bookId: string;
  let oldOwner: string;
  let newOwner: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    [{ id: clusterId }] = await db
      .insert(clusters)
      .values({ slug: "ce", name: "CE", pincodes: [], status: "open" })
      .returning({ id: clusters.id });
    [{ id: bookId }] = await db
      .insert(books)
      .values({
        isbn13: "9780062316097",
        title: "Sapiens",
        authors: ["Harari"],
        source: "google_books",
        listPricePaise: 49900,
      })
      .returning({ id: books.id });
    const ms = await db
      .insert(members)
      .values([
        {
          authUserId: crypto.randomUUID(),
          phoneHash: "a",
          displayName: "Old",
          clusterId,
          createdAt: daysAgo(30),
        },
        {
          authUserId: crypto.randomUUID(),
          phoneHash: "b",
          displayName: "New",
          clusterId,
          createdAt: daysAgo(3),
        },
      ])
      .returning({ id: members.id });
    oldOwner = ms[0].id;
    newOwner = ms[1].id;
  });
  afterAll(() => close());

  const details = {
    condition: "good" as const,
    replacementValuePaise: 45000,
    rentalPricePaise: 3000,
    loanPeriodDays: 21,
    allowedHandoffs: ["meetup" as const],
    minBorrowerTrust: 0,
    notes: "",
  };

  it("creates an available, unverified copy in the owner's cluster", async () => {
    const res = await createCopy(
      db,
      { ...details, ownerId: oldOwner, bookId, listingPhotoPath: "listing/x.jpg" },
      CONFIG_DEFAULTS,
      NOW,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.copy.availability).toBe("available");
      expect(res.copy.verificationStatus).toBe("unverified");
      expect(res.copy.clusterId).toBe(clusterId);
      expect(res.copy.replacementValuePaise).toBe(45000);
      expect(res.copy.rentalPricePaise).toBe(3000);
      expect(res.copy.loanPeriodDays).toBe(21);
    }
  });

  it("clamps an out-of-range replacement value", async () => {
    const res = await createCopy(
      db,
      {
        ...details,
        replacementValuePaise: 1000,
        ownerId: oldOwner,
        bookId,
        listingPhotoPath: "listing/y.jpg",
      },
      CONFIG_DEFAULTS,
      NOW,
    );
    expect(res.ok && res.copy.replacementValuePaise).toBe(10000);
  });

  it("enforces the 10-copy cap on a 3-day-old account and lifts it at 8 days", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await createCopy(
        db,
        { ...details, ownerId: newOwner, bookId, listingPhotoPath: `listing/n${i}.jpg` },
        CONFIG_DEFAULTS,
        NOW,
      );
      expect(r.ok, `copy ${i + 1}`).toBe(true);
    }
    const eleventh = await createCopy(
      db,
      { ...details, ownerId: newOwner, bookId, listingPhotoPath: "listing/n11.jpg" },
      CONFIG_DEFAULTS,
      NOW,
    );
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) expect(eleventh.error.code).toBe("listing_cap_reached");

    const later = new Date(NOW.getTime() + 5 * 86_400_000); // account now 8 days old
    const afterCap = await createCopy(
      db,
      { ...details, ownerId: newOwner, bookId, listingPhotoPath: "listing/n12.jpg" },
      CONFIG_DEFAULTS,
      later,
    );
    expect(afterCap.ok).toBe(true);
  });

  it("refuses an unknown book and a member without a cluster", async () => {
    const bad = await createCopy(
      db,
      { ...details, ownerId: oldOwner, bookId: crypto.randomUUID(), listingPhotoPath: "p" },
      CONFIG_DEFAULTS,
      NOW,
    );
    expect(!bad.ok && bad.error.code).toBe("book_not_found");
    const [{ id: noCluster }] = await db
      .insert(members)
      .values({ authUserId: crypto.randomUUID(), phoneHash: "c" })
      .returning({ id: members.id });
    const nc = await createCopy(
      db,
      { ...details, ownerId: noCluster, bookId, listingPhotoPath: "p" },
      CONFIG_DEFAULTS,
      NOW,
    );
    expect(!nc.ok && nc.error.code).toBe("member_not_onboarded");
  });

  it("unlists only available copies, and relists unlisted ones", async () => {
    const created = await createCopy(
      db,
      { ...details, ownerId: oldOwner, bookId, listingPhotoPath: "listing/u.jpg" },
      CONFIG_DEFAULTS,
      NOW,
    );
    const copyId = created.ok ? created.copy.id : "";
    expect(await unlistCopy(db, copyId, newOwner)).toEqual({ ok: false, error: "not_owner" });
    expect(await unlistCopy(db, copyId, oldOwner)).toEqual({ ok: true });
    expect(await unlistCopy(db, copyId, oldOwner)).toEqual({ ok: false, error: "not_unlisted" });
    expect(await relistCopy(db, copyId, oldOwner)).toEqual({ ok: true });

    await db.update(copies).set({ availability: "on_loan" }).where(eq(copies.id, copyId));
    expect(await unlistCopy(db, copyId, oldOwner)).toEqual({ ok: false, error: "on_loan" });
    await db.update(copies).set({ availability: "available" }).where(eq(copies.id, copyId));
  });

  it("updates details with clamping", async () => {
    const [c] = await db.select().from(copies).where(eq(copies.ownerId, oldOwner)).limit(1);
    const res = await updateCopyDetails(
      db,
      c.id,
      oldOwner,
      {
        ...details,
        condition: "worn",
        rentalPricePaise: 99900,
        loanPeriodDays: 28,
        replacementValuePaise: 250000,
        minBorrowerTrust: 50,
        allowedHandoffs: ["meetup", "courier"],
      },
      CONFIG_DEFAULTS,
    );
    expect(res).toEqual({ ok: true });
    const [after] = await db.select().from(copies).where(eq(copies.id, c.id));
    expect(after.condition).toBe("worn");
    expect(after.replacementValuePaise).toBe(100000);
    // Rental price is clamped to the configured ceiling (₹200).
    expect(after.rentalPricePaise).toBe(20000);
    expect(after.loanPeriodDays).toBe(28);
    expect(after.minBorrowerTrust).toBe(50);
  });

  it("lists the shelf with request counts", async () => {
    const shelf = await listShelf(db, oldOwner);
    expect(shelf.length).toBeGreaterThanOrEqual(3);
    expect(shelf[0].book.title).toBe("Sapiens");
    await db.insert(loans).values({
      copyId: shelf[0].id,
      bookId,
      lenderId: oldOwner,
      borrowerId: newOwner,
      state: "declined",
      handoffMethod: "meetup",
    });
    const again = await listShelf(db, oldOwner);
    expect(again.find((c) => c.id === shelf[0].id)?.requestCount).toBe(1);
  });

  it("creates a manual book flagged for review", async () => {
    const b = await createManualBook(db, {
      title: "Ghachar Ghochar",
      authors: ["Vivek Shanbhag"],
      language: "en",
      reviewPhotoPath: "review/x.jpg",
      createdBy: oldOwner,
    });
    expect(b.needsReview).toBe(true);
    expect(b.isbn13).toBeNull();
    expect(b.source).toBe("manual");
  });

  it("public profile shows listed copies and no private fields", async () => {
    const profile = await getPublicProfile(db, oldOwner);
    expect(profile?.displayName).toBe("Old");
    expect(profile?.trustScore).toBe(50);
    expect(profile?.acceptanceRate).toBeNull(); // fewer than 3 answered requests
    expect(profile!.copies.length).toBeGreaterThan(0);
    expect(
      profile!.copies.every((c) => c.availability === "available" || c.availability === "on_loan"),
    ).toBe(true);
    expect(JSON.stringify(profile)).not.toMatch(/phone|deposit|payout|authUserId/);
  });
});
