import type { books } from "@/db/schema";

/** What a provider hands back, ready to insert into `books`. */
export type CatalogueBook = {
  isbn13: string;
  title: string;
  authors: string[];
  publisher: string | null;
  publishedYear: number | null;
  /** ISO 639-1 */
  language: string;
  pageCount: number | null;
  coverUrl: string | null;
  /** Catalogue list price in paise, when the provider gives one in INR. */
  listPricePaise: number | null;
  source: "google_books" | "open_library";
};

export type BookRow = typeof books.$inferSelect;

/** Minimal fetch surface so providers can be tested without the network. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
