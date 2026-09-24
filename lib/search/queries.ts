import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { books, clusters, copies, members } from "@/db/schema";
import { looksLikeIsbn, toIsbn13 } from "@/lib/catalogue/isbn";

export type BookSummary = {
  id: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
  publishedYear: number | null;
  /** Copies available right now in the viewer's cluster. */
  availableInCluster: number;
  /** Listed copies (available or on loan) across the platform. */
  totalListed: number;
};

const SEARCH_LIMIT = 30;
/** word_similarity on titles: catches "harry poter" (0.79) and "Sapeins" (0.38); noise sits below 0.3. */
const TITLE_TRIGRAM_THRESHOLD = 0.35;
/** Authors need a closer match: at 0.35 "Martian" matched "Martin". */
const AUTHOR_TRIGRAM_THRESHOLD = 0.6;

/**
 * Requirement 3.1/3.2: title, author, or ISBN; ranked by available copies in
 * the cluster, then total listed copies, then text rank. Merged books are
 * excluded (their copies were repointed to the survivor).
 */
export async function searchBooks(
  db: DbOrTx,
  input: { query: string; clusterId: string | null; limit?: number },
): Promise<BookSummary[]> {
  const q = input.query.trim();
  if (q.length < 2) return [];
  const limit = input.limit ?? SEARCH_LIMIT;

  const availableInCluster = input.clusterId
    ? sql<number>`(select count(*) from copies c where c.book_id = ${books}.id and c.cluster_id = ${input.clusterId} and c.availability = 'available')`
    : sql<number>`0`;
  const totalListed = sql<number>`(select count(*) from copies c where c.book_id = ${books}.id and c.availability in ('available', 'on_loan'))`;

  let where;
  let rank;
  if (looksLikeIsbn(q)) {
    const isbn13 = toIsbn13(q);
    if (!isbn13) return [];
    where = eq(books.isbn13, isbn13);
    rank = sql<number>`1`;
  } else {
    const tsquery = sql`websearch_to_tsquery('simple', ${q})`;
    where = sql`(${books.searchVector} @@ ${tsquery}
      or word_similarity(${q}, ${books.title}) > ${TITLE_TRIGRAM_THRESHOLD}
      or word_similarity(${q}, immutable_array_to_string(${books.authors}, ' ')) > ${AUTHOR_TRIGRAM_THRESHOLD})`;
    rank = sql<number>`greatest(ts_rank(${books.searchVector}, ${tsquery}), word_similarity(${q}, ${books.title}))`;
  }

  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      authors: books.authors,
      coverUrl: books.coverUrl,
      publishedYear: books.publishedYear,
      availableInCluster: availableInCluster.as("available_in_cluster"),
      totalListed: totalListed.as("total_listed"),
      rank: rank.as("rank"),
    })
    .from(books)
    .where(and(sql`${books.mergedIntoId} is null`, where))
    .orderBy(desc(sql`available_in_cluster`), desc(sql`total_listed`), desc(sql`rank`), books.title)
    .limit(limit);

  return rows.map(({ rank: _rank, ...r }) => ({
    ...r,
    availableInCluster: Number(r.availableInCluster),
    totalListed: Number(r.totalListed),
  }));
}

export type ClusterSummary = {
  id: string;
  slug: string;
  name: string;
  status: "waitlist" | "open" | "paused";
  members: number;
  listedCopies: number;
  availableCopies: number;
};

export async function getClusterBySlug(db: DbOrTx, slug: string): Promise<ClusterSummary | null> {
  const [c] = await db
    .select({
      id: clusters.id,
      slug: clusters.slug,
      name: clusters.name,
      status: clusters.status,
      members: sql<number>`(select count(*) from members m where m.cluster_id = ${clusters}.id and m.deleted_at is null and m.display_name is not null)`,
      listedCopies: sql<number>`(select count(*) from copies c where c.cluster_id = ${clusters}.id and c.availability in ('available','on_loan'))`,
      availableCopies: sql<number>`(select count(*) from copies c where c.cluster_id = ${clusters}.id and c.availability = 'available')`,
    })
    .from(clusters)
    .where(eq(clusters.slug, slug))
    .limit(1);
  if (!c) return null;
  return {
    ...c,
    members: Number(c.members),
    listedCopies: Number(c.listedCopies),
    availableCopies: Number(c.availableCopies),
  };
}

export async function listOpenClusters(db: DbOrTx) {
  return db
    .select({ id: clusters.id, slug: clusters.slug, name: clusters.name })
    .from(clusters)
    .where(eq(clusters.status, "open"))
    .orderBy(clusters.name);
}

export type ClusterBrowse = {
  recentlyListed: BookSummary[];
  mostAvailable: BookSummary[];
};

/** Cluster browse page (task 8.3): newest listings and the most-stocked titles. */
export async function browseCluster(db: DbOrTx, clusterId: string): Promise<ClusterBrowse> {
  const availableInCluster = sql<number>`(select count(*) from copies c where c.book_id = ${books}.id and c.cluster_id = ${clusterId} and c.availability = 'available')`;
  const totalListed = sql<number>`(select count(*) from copies c where c.book_id = ${books}.id and c.availability in ('available','on_loan'))`;
  const select = {
    id: books.id,
    title: books.title,
    authors: books.authors,
    coverUrl: books.coverUrl,
    publishedYear: books.publishedYear,
    availableInCluster: availableInCluster.as("available_in_cluster"),
    totalListed: totalListed.as("total_listed"),
  };

  // Newest 30 distinct books with an available copy in the cluster.
  const recent = await db
    .select({ ...select, latest: sql<Date>`max(${copies.createdAt})`.as("latest") })
    .from(copies)
    .innerJoin(books, eq(books.id, copies.bookId))
    .where(
      and(
        eq(copies.clusterId, clusterId),
        eq(copies.availability, "available"),
        sql`${books.mergedIntoId} is null`,
      ),
    )
    .groupBy(books.id)
    .orderBy(desc(sql`latest`))
    .limit(30);

  const most = await db
    .select(select)
    .from(books)
    .where(
      and(
        sql`${books.mergedIntoId} is null`,
        sql`exists (select 1 from copies c where c.book_id = ${books}.id and c.cluster_id = ${clusterId} and c.availability = 'available')`,
      ),
    )
    .orderBy(desc(sql`available_in_cluster`), desc(sql`total_listed`), books.title)
    .limit(12);

  const norm = (
    r: { availableInCluster: number; totalListed: number } & Record<string, unknown>,
  ) => ({
    ...r,
    availableInCluster: Number(r.availableInCluster),
    totalListed: Number(r.totalListed),
  });
  return {
    recentlyListed: recent.map(({ latest: _l, ...r }) => norm(r) as BookSummary),
    mostAvailable: most.map((r) => norm(r) as BookSummary),
  };
}

export type BookPageCopy = {
  id: string;
  condition: (typeof copies.$inferSelect)["condition"];
  verificationStatus: (typeof copies.$inferSelect)["verificationStatus"];
  availability: "available" | "on_loan";
  allowedHandoffs: (typeof copies.$inferSelect)["allowedHandoffs"];
  minBorrowerTrust: number;
  replacementValuePaise: number;
  notes: string | null;
  listingPhotoPath: string;
  lender: { id: string; displayName: string; trustScore: number; acceptanceRate: number | null };
};

export type BookPage = {
  book: {
    id: string;
    isbn13: string | null;
    title: string;
    authors: string[];
    publisher: string | null;
    publishedYear: number | null;
    pageCount: number | null;
    coverUrl: string | null;
    needsReview: boolean;
    mergedIntoId: string | null;
  };
  copies: BookPageCopy[];
  /** Copies elsewhere (other clusters), counts only. */
  listedElsewhere: number;
};

/**
 * Requirement 3.3: copies in the cluster with condition, verification, lender
 * name, trust, acceptance rate, handoff methods; verified first, then by trust.
 * Lender identity is included; the page hides it for signed-out viewers (3.4).
 */
export async function getBookPage(
  db: DbOrTx,
  bookId: string,
  clusterId: string | null,
): Promise<BookPage | null> {
  const [book] = await db
    .select({
      id: books.id,
      isbn13: books.isbn13,
      title: books.title,
      authors: books.authors,
      publisher: books.publisher,
      publishedYear: books.publishedYear,
      pageCount: books.pageCount,
      coverUrl: books.coverUrl,
      needsReview: books.needsReview,
      mergedIntoId: books.mergedIntoId,
    })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!book) return null;

  // Acceptance rate over each lender's last 20 answered requests (design.md Trust Score).
  const acceptance = sql<number | null>`(
    select case when count(*) >= 3 then sum(case when l.state not in ('declined','expired') then 1 else 0 end)::float / count(*) else null end
    from (select state from loans l where l.lender_id = ${members}.id and l.state <> 'requested' order by l.requested_at desc limit 20) l
  )`;

  const rows = clusterId
    ? await db
        .select({
          id: copies.id,
          condition: copies.condition,
          verificationStatus: copies.verificationStatus,
          availability: copies.availability,
          allowedHandoffs: copies.allowedHandoffs,
          minBorrowerTrust: copies.minBorrowerTrust,
          replacementValuePaise: copies.replacementValuePaise,
          notes: copies.notes,
          listingPhotoPath: copies.listingPhotoPath,
          lenderId: members.id,
          lenderName: members.displayName,
          lenderTrust: members.trustScore,
          acceptanceRate: acceptance.as("acceptance_rate"),
        })
        .from(copies)
        .innerJoin(members, eq(members.id, copies.ownerId))
        .where(
          and(
            eq(copies.bookId, bookId),
            eq(copies.clusterId, clusterId),
            inArray(copies.availability, ["available", "on_loan"]),
            sql`${members.deletedAt} is null`,
          ),
        )
        .orderBy(
          desc(copies.verificationStatus),
          desc(sql`${copies.availability} = 'available'`),
          desc(members.trustScore),
          copies.createdAt,
        )
    : [];

  const [{ elsewhere }] = await db
    .select({ elsewhere: sql<number>`count(*)` })
    .from(copies)
    .where(
      and(
        eq(copies.bookId, bookId),
        inArray(copies.availability, ["available", "on_loan"]),
        clusterId ? sql`${copies.clusterId} <> ${clusterId}` : sql`true`,
      ),
    );

  return {
    book,
    copies: rows.map((r) => ({
      id: r.id,
      condition: r.condition,
      verificationStatus: r.verificationStatus,
      availability: r.availability as "available" | "on_loan",
      allowedHandoffs: r.allowedHandoffs,
      minBorrowerTrust: r.minBorrowerTrust,
      replacementValuePaise: r.replacementValuePaise,
      notes: r.notes,
      listingPhotoPath: r.listingPhotoPath,
      lender: {
        id: r.lenderId,
        displayName: r.lenderName ?? "Member",
        trustScore: r.lenderTrust,
        acceptanceRate: r.acceptanceRate === null ? null : Number(r.acceptanceRate),
      },
    })),
    listedElsewhere: Number(elsewhere),
  };
}
