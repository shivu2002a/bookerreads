"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { searchAction } from "@/app/(public)/search/actions";
import { BookResultList, BookResultSkeleton } from "@/components/book-result-list";
import { Input } from "@/components/ui/input";
import type { BookSummary } from "@/lib/search/queries";

const DEBOUNCE_MS = 150;
const MIN_CHARS = 2;

/**
 * Debounced search island (task 8.2). Results come from a server action;
 * the URL `?q=` stays in sync so results are shareable and back navigation works.
 * On error the last good results stay on screen with a retry link.
 */
export function SearchBox({
  clusterId,
  clusterSlug,
  initialQuery,
  initialResults,
}: {
  clusterId: string | null;
  clusterSlug?: string;
  initialQuery: string;
  initialResults: BookSummary[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState(initialResults);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const latest = useRef(0);

  function run(q: string) {
    const id = ++latest.current;
    startTransition(async () => {
      try {
        const res = await searchAction({ query: q, clusterId });
        if (id !== latest.current) return; // a newer query superseded this one
        setResults(res);
        setError(false);
      } catch {
        if (id === latest.current) setError(true);
      }
    });
  }

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      run(q);
      const next = new URLSearchParams(params.toString());
      next.set("q", q);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on query change
  }, [query]);

  const showSkeleton = pending && results.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        inputMode="search"
        autoComplete="off"
        placeholder="Title, author, or ISBN"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search books"
        autoFocus={!initialQuery}
        className="h-11 text-base"
      />
      {error && (
        <p className="text-destructive text-sm">
          Couldn&apos;t load results.{" "}
          <button type="button" className="underline" onClick={() => run(query.trim())}>
            Try again
          </button>
        </p>
      )}
      {query.trim().length < MIN_CHARS ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          Type at least two characters.
        </p>
      ) : showSkeleton ? (
        <BookResultSkeleton />
      ) : (
        <div className={pending ? "opacity-60 transition-opacity" : undefined}>
          <BookResultList
            books={results}
            clusterSlug={clusterSlug}
            emptyMessage={`No books match "${query.trim()}".`}
          />
        </div>
      )}
    </div>
  );
}
