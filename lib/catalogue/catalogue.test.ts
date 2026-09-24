import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { books } from "@/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import googleFixture from "./fixtures/google-books-isbn.json";
import olAuthor from "./fixtures/open-library-author.json";
import olEdition from "./fixtures/open-library-isbn.json";
import olWork from "./fixtures/open-library-work.json";
import { getJson, ProviderError, TokenBucket } from "./http";
import { lookupByIsbn } from "./lookup";
import { fetchGoogleBooks, mapGoogleVolume } from "./providers/google-books";
import { fetchOpenLibrary, mapOpenLibraryEdition, type OlEdition } from "./providers/open-library";
import type { Fetcher } from "./types";

const SAPIENS = "9780062316097";

/** Routes URLs to canned responses; unknown URLs get a 404. */
function fakeFetcher(
  routes: Record<string, unknown | (() => Response)>,
): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        if (typeof body === "function") return (body as () => Response)();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

describe("mapGoogleVolume", () => {
  it("maps a volume to a catalogue book with INR price in paise", () => {
    const b = mapGoogleVolume(SAPIENS, googleFixture);
    expect(b).toMatchObject({
      isbn13: SAPIENS,
      title: "Sapiens: A Brief History of Humankind",
      authors: ["Yuval Noah Harari"],
      publisher: "Harper",
      publishedYear: 2015,
      language: "en",
      pageCount: 464,
      listPricePaise: 49900,
      source: "google_books",
    });
    expect(b?.coverUrl).toMatch(/^https:\/\/books\.google\.com/);
    expect(b?.coverUrl).not.toContain("edge=curl");
  });

  it("returns null when there are no items or no title", () => {
    expect(mapGoogleVolume(SAPIENS, { totalItems: 0, items: [] })).toBeNull();
    expect(mapGoogleVolume(SAPIENS, null)).toBeNull();
    expect(mapGoogleVolume(SAPIENS, { items: [{ id: "x", volumeInfo: {} }] })).toBeNull();
  });

  it("ignores non-INR prices", () => {
    const fx = structuredClone(googleFixture);
    fx.items[0].saleInfo.listPrice.currencyCode = "USD";
    expect(mapGoogleVolume(SAPIENS, fx)?.listPricePaise).toBeNull();
  });
});

describe("mapOpenLibraryEdition", () => {
  it("maps an edition with resolved author names and a cover", () => {
    const b = mapOpenLibraryEdition(SAPIENS, olEdition as OlEdition, ["Yuval Noah Harari"]);
    expect(b).toMatchObject({
      isbn13: SAPIENS,
      title: "Sapiens: A Brief History of Humankind",
      authors: ["Yuval Noah Harari"],
      publisher: "Harper",
      publishedYear: 2015,
      language: "en",
      listPricePaise: null,
      source: "open_library",
      coverUrl: "https://covers.openlibrary.org/b/id/8594920-L.jpg",
    });
  });

  it("extracts a year from messy publish dates and maps languages", () => {
    const b = mapOpenLibraryEdition(
      "9780000000002",
      {
        title: "T",
        publish_date: "March 3, 1998",
        languages: [{ key: "/languages/kan" }],
      },
      [],
    );
    expect(b?.publishedYear).toBe(1998);
    expect(b?.language).toBe("kn");
  });
});

describe("fetchOpenLibrary", () => {
  it("falls back to the work's authors when the edition has none", async () => {
    const fetcher = fakeFetcher({
      [`https://openlibrary.org/isbn/${SAPIENS}.json`]: olEdition,
      "https://openlibrary.org/works/OL17075811W.json": olWork,
      "https://openlibrary.org/authors/OL3778242A.json": olAuthor,
    });
    const b = await fetchOpenLibrary(SAPIENS, { fetcher });
    expect(b?.authors).toEqual(["Yuval Noah Harari"]);
    expect(fetcher.calls).toHaveLength(3);
  });

  it("returns null on 404", async () => {
    expect(await fetchOpenLibrary("9780000000002", { fetcher: fakeFetcher({}) })).toBeNull();
  });
});

describe("getJson", () => {
  it("retries once on 5xx and then throws a ProviderError", async () => {
    let n = 0;
    const fetcher: Fetcher = async () => {
      n++;
      return new Response("boom", { status: 503 });
    };
    await expect(getJson("https://x", { provider: "p", fetcher })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(n).toBe(2);
  });

  it("does not retry on 4xx other than 429", async () => {
    let n = 0;
    const fetcher: Fetcher = async () => {
      n++;
      return new Response("bad", { status: 400 });
    };
    await expect(getJson("https://x", { provider: "p", fetcher })).rejects.toMatchObject({
      kind: "http",
      status: 400,
    });
    expect(n).toBe(1);
  });

  it("times out", async () => {
    const fetcher: Fetcher = (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        ),
      );
    await expect(
      getJson("https://x", { provider: "p", fetcher, timeoutMs: 20, retries: 0 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("honours the token bucket", async () => {
    let t = 0;
    const bucket = new TokenBucket(2, 1, () => t);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    t = 1000;
    expect(bucket.tryTake()).toBe(true);
  });
});

describe("lookupByIsbn (db)", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  const google = (fetcher: Fetcher) => ({
    name: "google_books" as const,
    fetch: (i: string) => fetchGoogleBooks(i, { fetcher }),
  });
  const openLib = (fetcher: Fetcher) => ({
    name: "open_library" as const,
    fetch: (i: string) => fetchOpenLibrary(i, { fetcher }),
  });

  it("rejects an invalid ISBN without touching providers", async () => {
    const fetcher = fakeFetcher({});
    expect(await lookupByIsbn(db, "Sapiens", { providers: [google(fetcher)] })).toEqual({
      status: "invalid_isbn",
    });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("fetches from Google first, inserts, then serves from cache", async () => {
    const fetcher = fakeFetcher({ "https://www.googleapis.com/books/v1/volumes": googleFixture });
    const first = await lookupByIsbn(db, "978-0-06-231609-7", {
      providers: [google(fetcher), openLib(fetcher)],
    });
    expect(first.status).toBe("found");
    if (first.status === "found") {
      expect(first.from).toBe("google_books");
      expect(first.book.title).toBe("Sapiens: A Brief History of Humankind");
    }
    const second = await lookupByIsbn(db, SAPIENS, {
      providers: [google(fetcher), openLib(fetcher)],
    });
    expect(second.status === "found" && second.from).toBe("cache");
    expect(fetcher.calls).toHaveLength(1);
  });

  it("falls through to Open Library when Google has nothing or fails", async () => {
    const isbn = "9780306406157";
    const edition: OlEdition = {
      title: "Fallback Book",
      authors: [{ key: "/authors/OL1A" }],
      publish_date: "2001",
    };
    const fetcher = fakeFetcher({
      "https://www.googleapis.com/books/v1/volumes": () =>
        new Response("rate limited", { status: 429 }),
      [`https://openlibrary.org/isbn/${isbn}.json`]: edition,
      "https://openlibrary.org/authors/OL1A.json": { name: "Some Author" },
    });
    const log = vi.fn();
    const res = await lookupByIsbn(db, isbn, {
      providers: [google(fetcher), openLib(fetcher)],
      log,
    });
    expect(res.status).toBe("found");
    if (res.status === "found") {
      expect(res.from).toBe("open_library");
      expect(res.book.authors).toEqual(["Some Author"]);
    }
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("google_books failed"),
      expect.objectContaining({ kind: "http" }),
    );
  });

  it("returns not_found when every provider misses, without inserting", async () => {
    const isbn = "9780804429573";
    const res = await lookupByIsbn(db, isbn, {
      providers: [google(fakeFetcher({})), openLib(fakeFetcher({}))],
      log: () => {},
    });
    expect(res).toEqual({ status: "not_found", isbn13: isbn });
    expect(await db.select().from(books).where(eq(books.isbn13, isbn))).toHaveLength(0);
  });

  it("follows an admin merge to the surviving record", async () => {
    const [survivor] = await db
      .insert(books)
      .values({
        isbn13: "9780143127741",
        title: "The Martian",
        authors: ["Andy Weir"],
        source: "manual",
      })
      .returning();
    const [dupe] = await db
      .insert(books)
      .values({
        isbn13: "9780553418026",
        title: "The Martian (dupe)",
        authors: ["Andy Weir"],
        source: "manual",
        mergedIntoId: survivor.id,
      })
      .returning();
    const res = await lookupByIsbn(db, dupe.isbn13!, { providers: [] });
    expect(res.status === "found" && res.book.id).toBe(survivor.id);
  });
});
