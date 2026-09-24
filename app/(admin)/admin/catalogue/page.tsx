import Link from "next/link";
import { getDb } from "@/db/client";
import { listReviewQueue, searchBooksAdmin } from "@/lib/admin/catalogue";
import { when } from "../_components/fmt";

export default async function AdminCataloguePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const db = getDb();
  const [queue, results] = await Promise.all([
    listReviewQueue(db),
    q ? searchBooksAdmin(db, q) : Promise.resolve([]),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Catalogue</h1>
      <section>
        <h2 className="text-muted-foreground mb-1 text-sm font-medium">
          Review queue · {queue.length}
        </h2>
        {queue.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing to review.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {queue.map(({ book, copies }) => (
              <li key={book.id} className="flex items-center justify-between px-3 py-1.5">
                <span>
                  <Link href={`/admin/catalogue/${book.id}`} className="underline">
                    {book.title}
                  </Link>{" "}
                  · {book.authors.join(", ")} · {Number(copies)} cop
                  {Number(copies) === 1 ? "y" : "ies"}
                </span>
                <span className="text-muted-foreground text-xs">{when.format(book.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="text-muted-foreground mb-1 text-sm font-medium">Find a book</h2>
        <form className="mb-2 flex gap-2">
          <input
            name="q"
            defaultValue={q}
            placeholder="Title or ISBN"
            className="bg-background h-9 w-80 rounded-md border px-3 text-sm"
          />
          <button className="h-9 rounded-md border px-3 text-sm">Search</button>
        </form>
        {results.length > 0 && (
          <ul className="divide-y rounded-lg border text-sm">
            {results.map((b) => (
              <li key={b.id} className="px-3 py-1.5">
                <Link href={`/admin/catalogue/${b.id}`} className="underline">
                  {b.title}
                </Link>{" "}
                · {b.authors.join(", ")} · {b.isbn13 ?? "no ISBN"}
                {b.mergedIntoId && (
                  <span className="text-muted-foreground ml-2 text-xs">merged</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
