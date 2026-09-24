import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { baseColumns, tsvector } from "./_shared";
import { bookSource } from "./enums";

/** One record per edition, identified by ISBN-13 where known. */
export const books = pgTable(
  "books",
  {
    ...baseColumns,
    isbn13: text("isbn13").unique(), // null for manual entries
    title: text("title").notNull(),
    authors: text("authors").array().notNull().default([]),
    publisher: text("publisher"),
    publishedYear: smallint("published_year"),
    language: text("language").notNull().default("en"), // ISO 639-1
    pageCount: integer("page_count"),
    coverUrl: text("cover_url"),
    /** Catalogue list price, used as the default replacement value. */
    listPricePaise: integer("list_price_paise"),
    source: bookSource("source").notNull(),
    needsReview: boolean("needs_review").notNull().default(false),
    /** Title-page photo for manual entries awaiting admin review. */
    reviewPhotoPath: text("review_photo_path"),
    /** Set after an admin merges this record into another; readers redirect. */
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => books.id),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        // immutable_array_to_string is defined in migration 0000; array_to_string itself is only STABLE.
        sql`setweight(to_tsvector('simple', coalesce(${books.title}, '')), 'A') || setweight(to_tsvector('simple', immutable_array_to_string(${books.authors}, ' ')), 'B')`,
    ),
  },
  (t) => [
    index("books_search_vector_idx").using("gin", t.searchVector),
    // Trigram index for typo-tolerant title search. Requires pg_trgm (created in migration 0000).
    index("books_title_trgm_idx").using("gin", sql`${t.title} gin_trgm_ops`),
    index("books_needs_review_idx")
      .on(t.needsReview)
      .where(sql`${t.needsReview} = true`),
  ],
);
