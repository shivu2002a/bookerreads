import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { books } from "@/db/schema";
import { ProviderError } from "./http";
import { toIsbn13 } from "./isbn";
import { fetchGoogleBooks } from "./providers/google-books";
import { fetchOpenLibrary } from "./providers/open-library";
import type { BookRow, CatalogueBook, Fetcher } from "./types";

export type LookupResult =
  | { status: "found"; book: BookRow; from: "cache" | "google_books" | "open_library" }
  | { status: "not_found"; isbn13: string }
  | { status: "invalid_isbn" };

export type Provider = (isbn13: string) => Promise<CatalogueBook | null>;

export type LookupDeps = {
  /** Ordered; the first to return a book wins. */
  providers?: Array<{ name: "google_books" | "open_library"; fetch: Provider }>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export function defaultProviders(opts: { fetcher?: Fetcher; googleApiKey?: string } = {}) {
  return [
    {
      name: "google_books" as const,
      fetch: (isbn: string) =>
        fetchGoogleBooks(isbn, { fetcher: opts.fetcher, apiKey: opts.googleApiKey }),
    },
    {
      name: "open_library" as const,
      fetch: (isbn: string) => fetchOpenLibrary(isbn, { fetcher: opts.fetcher }),
    },
  ];
}

/**
 * design.md Catalogue Resolution: local `books` -> Google Books -> Open Library.
 * Provider failures are logged and degrade to the next provider, then to
 * `not_found`, so a flaky provider never blocks listing (Requirement 2.1).
 * The first hit is inserted, so every ISBN is fetched externally at most once.
 */
export async function lookupByIsbn(
  db: DbOrTx,
  rawIsbn: string,
  deps: LookupDeps = {},
): Promise<LookupResult> {
  const isbn13 = toIsbn13(rawIsbn);
  if (!isbn13) return { status: "invalid_isbn" };

  const cached = await db.select().from(books).where(eq(books.isbn13, isbn13)).limit(1);
  if (cached[0]) return { status: "found", book: await followMerge(db, cached[0]), from: "cache" };

  const providers = deps.providers ?? defaultProviders();
  const log = deps.log ?? ((msg, meta) => console.warn(msg, meta));

  for (const provider of providers) {
    let result: CatalogueBook | null;
    try {
      result = await provider.fetch(isbn13);
    } catch (err) {
      const kind = err instanceof ProviderError ? err.kind : "unknown";
      log(`catalogue: ${provider.name} failed`, { isbn13, kind, message: (err as Error).message });
      continue;
    }
    if (!result) continue;

    const inserted = await db
      .insert(books)
      .values({
        isbn13: result.isbn13,
        title: result.title,
        authors: result.authors,
        publisher: result.publisher,
        publishedYear: result.publishedYear,
        language: result.language,
        pageCount: result.pageCount,
        coverUrl: result.coverUrl,
        listPricePaise: result.listPricePaise,
        source: result.source,
      })
      .onConflictDoNothing({ target: books.isbn13 })
      .returning();
    if (inserted[0]) return { status: "found", book: inserted[0], from: provider.name };

    // Raced with another request that inserted the same ISBN.
    const raced = await db.select().from(books).where(eq(books.isbn13, isbn13)).limit(1);
    if (raced[0]) return { status: "found", book: raced[0], from: "cache" };
  }

  return { status: "not_found", isbn13 };
}

/** After an admin merge the old record points at the survivor; return the survivor. */
export async function followMerge(db: DbOrTx, book: BookRow, depth = 0): Promise<BookRow> {
  if (!book.mergedIntoId || depth > 5) return book;
  const [target] = await db.select().from(books).where(eq(books.id, book.mergedIntoId)).limit(1);
  return target ? followMerge(db, target, depth + 1) : book;
}
