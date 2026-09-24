import Link from "next/link";
import { BookCover } from "@/components/book-cover";
import type { BookSummary } from "@/lib/search/queries";

export function BookResultList({
  books,
  clusterSlug,
  emptyMessage = "No books match.",
}: {
  books: BookSummary[];
  /** Carried in the link so signed-out viewers keep their cluster context. */
  clusterSlug?: string;
  emptyMessage?: string;
}) {
  if (!books.length)
    return <p className="text-muted-foreground py-6 text-center text-sm">{emptyMessage}</p>;
  const suffix = clusterSlug ? `?c=${clusterSlug}` : "";
  return (
    <ul className="flex flex-col divide-y">
      {books.map((b) => (
        <li key={b.id}>
          <Link href={`/b/${b.id}${suffix}`} className="hover:bg-muted/50 flex gap-3 py-3">
            <BookCover src={b.coverUrl} title={b.title} className="w-12 shrink-0" sizes="48px" />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 leading-tight font-medium">{b.title}</p>
              <p className="text-muted-foreground truncate text-sm">{b.authors.join(", ")}</p>
              <p className="mt-1 text-xs">
                {b.availableInCluster > 0 ? (
                  <span className="font-medium text-green-700">
                    {b.availableInCluster} available near you
                  </span>
                ) : b.totalListed > 0 ? (
                  <span className="text-muted-foreground">
                    {b.totalListed} listed, none available nearby
                  </span>
                ) : (
                  <span className="text-muted-foreground">No copies listed yet</span>
                )}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function BookResultSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="flex flex-col divide-y" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex gap-3 py-3">
          <div className="bg-muted aspect-[2/3] w-12 animate-pulse rounded" />
          <div className="flex flex-1 flex-col gap-2 py-1">
            <div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
            <div className="bg-muted h-3 w-1/2 animate-pulse rounded" />
            <div className="bg-muted h-3 w-1/3 animate-pulse rounded" />
          </div>
        </li>
      ))}
    </ul>
  );
}
