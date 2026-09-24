import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { books, clusters, copies } from "@/db/schema";
import { seed } from "@/db/seed/run";
import { createTestDb, type TestDb } from "@/test/db";
import { browseCluster, getBookPage, getClusterBySlug, searchBooks } from "./queries";

let db: TestDb;
let close: () => Promise<void>;
let clusterId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seed(db, { now: new Date("2026-09-21T10:00:00Z") });
  [{ id: clusterId }] = await db
    .select({ id: clusters.id })
    .from(clusters)
    .where(eq(clusters.slug, "central-east"));
}, 60_000);
afterAll(() => close());

describe("searchBooks", () => {
  it("finds a book by exact ISBN", async () => {
    const [b] = await db
      .select({ isbn13: books.isbn13, title: books.title })
      .from(books)
      .where(sql`${books.isbn13} is not null`)
      .limit(1);
    const res = await searchBooks(db, {
      query: `${b.isbn13!.slice(0, 3)}-${b.isbn13!.slice(3)}`,
      clusterId,
    });
    expect(res.map((r) => r.title)).toEqual([b.title]);
  });

  it("tolerates typos in the title", async () => {
    const res = await searchBooks(db, { query: "harry poter", clusterId });
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => r.title.startsWith("Harry Potter"))).toBe(true);
  });

  it("matches by author through full-text search", async () => {
    const res = await searchBooks(db, { query: "colleen hoover", clusterId });
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => r.authors.some((a) => a.includes("Hoover")))).toBe(true);
  });

  it("ranks books with copies available in the cluster first", async () => {
    const res = await searchBooks(db, { query: "the", clusterId, limit: 30 });
    for (let i = 1; i < res.length; i++) {
      const prev = res[i - 1];
      const cur = res[i];
      expect(
        prev.availableInCluster >= cur.availableInCluster ||
          (prev.availableInCluster === cur.availableInCluster &&
            prev.totalListed >= cur.totalListed),
      ).toBe(true);
    }
  });

  it("does not count unlisted copies", async () => {
    // Pick a book whose only copy in the cluster is unlisted.
    const [row] = await db
      .execute<{ book_id: string; title: string }>(
        sql`
      select c.book_id, b.title from copies c join books b on b.id = c.book_id
      where c.availability = 'unlisted'
        and not exists (select 1 from copies c2 where c2.book_id = c.book_id and c2.availability in ('available','on_loan'))
      limit 1`,
      )
      .then((r) => r.rows);
    if (!row) return; // seed variant without such a book; nothing to assert
    const res = await searchBooks(db, { query: row.title, clusterId });
    const hit = res.find((r) => r.id === row.book_id);
    expect(hit?.availableInCluster ?? 0).toBe(0);
    expect(hit?.totalListed ?? 0).toBe(0);
  });

  it("returns nothing for a one-character query or a bad ISBN", async () => {
    expect(await searchBooks(db, { query: "a", clusterId })).toEqual([]);
    expect(await searchBooks(db, { query: "9780062316098", clusterId })).toEqual([]);
  });

  it("excludes merged books", async () => {
    const [survivor] = await db
      .insert(books)
      .values({
        isbn13: "9780143127741",
        title: "The Martian Zzq",
        authors: ["Andy Weir"],
        source: "manual",
      })
      .returning();
    await db.insert(books).values({
      isbn13: "9780553418026",
      title: "The Martian Zzq (dupe)",
      authors: ["Andy Weir"],
      source: "manual",
      mergedIntoId: survivor.id,
    });
    const res = await searchBooks(db, { query: "Martian Zzq", clusterId });
    expect(res.map((r) => r.id)).toEqual([survivor.id]);
  });
});

describe("cluster browse", () => {
  it("summarises the cluster", async () => {
    const c = await getClusterBySlug(db, "central-east");
    expect(c?.status).toBe("open");
    expect(c!.members).toBe(30);
    expect(c!.listedCopies).toBeGreaterThan(200);
    expect(c!.availableCopies).toBeLessThanOrEqual(c!.listedCopies);
    expect(await getClusterBySlug(db, "nope")).toBeNull();
  });

  it("lists recent and most-available books with counts", async () => {
    const b = await browseCluster(db, clusterId);
    expect(b.recentlyListed.length).toBe(30);
    expect(b.mostAvailable.length).toBeGreaterThan(0);
    expect(b.mostAvailable[0].availableInCluster).toBeGreaterThanOrEqual(
      b.mostAvailable[b.mostAvailable.length - 1].availableInCluster,
    );
    expect(b.recentlyListed.every((r) => r.availableInCluster > 0)).toBe(true);
  });
});

describe("getBookPage", () => {
  it("lists copies in the cluster, verified first, with lender trust and acceptance", async () => {
    const [{ book_id }] = await db
      .execute<{ book_id: string }>(
        sql`
      select book_id from copies where cluster_id = ${clusterId} and availability in ('available','on_loan')
      group by book_id having count(*) >= 2 order by count(*) desc limit 1`,
      )
      .then((r) => r.rows);
    const page = await getBookPage(db, book_id, clusterId);
    expect(page).not.toBeNull();
    expect(page!.copies.length).toBeGreaterThanOrEqual(2);
    const verifiedFlags = page!.copies.map((c) => c.verificationStatus === "verified");
    // Once we see an unverified copy, no verified copy may follow.
    const firstUnverified = verifiedFlags.indexOf(false);
    if (firstUnverified >= 0)
      expect(verifiedFlags.slice(firstUnverified).every((v) => !v)).toBe(true);
    for (const c of page!.copies) {
      expect(c.lender.displayName).toBeTruthy();
      expect(c.lender.trustScore).toBeGreaterThanOrEqual(0);
      expect(
        c.lender.acceptanceRate === null ||
          (c.lender.acceptanceRate >= 0 && c.lender.acceptanceRate <= 1),
      ).toBe(true);
    }
    expect(JSON.stringify(page)).not.toMatch(/phone|deposit|payout/);
  });

  it("returns counts only when no cluster is given", async () => {
    const [c] = await db.select({ bookId: copies.bookId }).from(copies).limit(1);
    const page = await getBookPage(db, c.bookId, null);
    expect(page!.copies).toEqual([]);
    expect(page!.listedElsewhere).toBeGreaterThan(0);
  });

  it("returns null for an unknown book", async () => {
    expect(await getBookPage(db, crypto.randomUUID(), clusterId)).toBeNull();
  });
});
