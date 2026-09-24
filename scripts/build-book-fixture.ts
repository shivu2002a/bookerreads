/**
 * One-off: pulls real books from Open Library's search API and writes
 * db/fixtures/books.json (200 entries with ISBN-13, title, authors, year,
 * pages, cover, and a rough list price in paise for replacement defaults).
 *
 *   pnpm tsx scripts/build-book-fixture.ts
 *
 * The output is checked in; the seed does not call the network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isValidIsbn13, normaliseIsbn } from "../lib/catalogue/isbn";

type OlDoc = {
  title?: string;
  author_name?: string[];
  isbn?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  publisher?: string[];
  language?: string[];
  cover_i?: number;
};

export type BookFixture = {
  isbn13: string;
  title: string;
  authors: string[];
  publisher: string | null;
  publishedYear: number | null;
  language: string;
  pageCount: number | null;
  coverUrl: string | null;
  listPricePaise: number;
};

const SUBJECTS = [
  "fiction",
  "science_fiction",
  "fantasy",
  "mystery",
  "history",
  "biography",
  "science",
  "economics",
  "psychology",
  "indian_literature",
  "philosophy",
  "travel",
];

const TARGET = 200;
const UA = "BookerReads fixture builder (dev@bookerreads.in)";

async function fetchSubject(subject: string): Promise<OlDoc[]> {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("q", `subject:${subject} language:eng`);
  url.searchParams.set(
    "fields",
    "title,author_name,isbn,first_publish_year,number_of_pages_median,publisher,language,cover_i",
  );
  url.searchParams.set("limit", "60");
  url.searchParams.set("sort", "readinglog");
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${subject}: HTTP ${res.status}`);
  const json = (await res.json()) as { docs: OlDoc[] };
  return json.docs;
}

function pickIsbn13(isbns: string[] | undefined): string | null {
  for (const raw of isbns ?? []) {
    const n = normaliseIsbn(raw);
    if (n && isValidIsbn13(n) && n.startsWith("978")) return n;
  }
  return null;
}

/** Deterministic pseudo price so the seed has believable replacement defaults. */
function priceFor(isbn13: string, pages: number | null): number {
  const base = 299 + ((Number(isbn13.slice(-4)) % 8) + 1) * 50; // 349..699
  const pageBump = pages && pages > 400 ? 100 : 0;
  return (base + pageBump) * 100;
}

async function main() {
  const seen = new Set<string>();
  const out: BookFixture[] = [];

  for (const subject of SUBJECTS) {
    if (out.length >= TARGET) break;
    const docs = await fetchSubject(subject);
    for (const d of docs) {
      if (out.length >= TARGET) break;
      const isbn13 = pickIsbn13(d.isbn);
      if (!isbn13 || seen.has(isbn13) || !d.title || !d.author_name?.length) continue;
      if (d.title.length > 120) continue;
      seen.add(isbn13);
      const pages = d.number_of_pages_median ?? null;
      out.push({
        isbn13,
        title: d.title,
        authors: d.author_name.slice(0, 3),
        publisher: d.publisher?.[0] ?? null,
        publishedYear: d.first_publish_year ?? null,
        language: "en",
        pageCount: pages,
        coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
        listPricePaise: priceFor(isbn13, pages),
      });
    }
    console.log(`${subject}: total ${out.length}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  if (out.length < TARGET) throw new Error(`only collected ${out.length} books`);

  const dir = path.resolve(__dirname, "../db/fixtures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "books.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${out.length} books`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
