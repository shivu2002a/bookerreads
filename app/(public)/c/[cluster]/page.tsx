import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookCover } from "@/components/book-cover";
import { BookResultList } from "@/components/book-result-list";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { browseCluster, getClusterBySlug } from "@/lib/search/queries";

type Params = { params: Promise<{ cluster: string }> };

// Public and identical for every viewer; cache for a minute (task 8.3).
export const revalidate = 60;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { cluster } = await params;
  const c = await getClusterBySlug(getDb(), cluster);
  return { title: c ? `${c.name} · Browse` : "Browse" };
}

export default async function ClusterPage({ params }: Params) {
  const { cluster: slug } = await params;
  const db = getDb();
  const cluster = await getClusterBySlug(db, slug);
  if (!cluster) notFound();

  if (cluster.status !== "open") {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{cluster.name}</h1>
        <p className="text-muted-foreground text-sm">
          This area isn&apos;t open yet. Sign up and enter your pincode to join the waitlist;
          we&apos;ll message you when it opens.
        </p>
        <Button render={<Link href="/login" />}>Join the waitlist</Button>
      </div>
    );
  }

  const browse = await browseCluster(db, cluster.id);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{cluster.name}</h1>
        <p className="text-muted-foreground text-sm">
          {cluster.members} members · {cluster.listedCopies} books on shelves ·{" "}
          {cluster.availableCopies} available now
        </p>
        <Button variant="outline" render={<Link href={`/search?c=${cluster.slug}`} />}>
          Search this area
        </Button>
      </header>

      {browse.mostAvailable.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground text-sm font-medium">Most copies available</h2>
          <ul className="grid grid-cols-4 gap-3 sm:grid-cols-6">
            {browse.mostAvailable.map((b, i) => (
              <li key={b.id}>
                <Link href={`/b/${b.id}?c=${cluster.slug}`} className="flex flex-col gap-1">
                  <BookCover
                    src={b.coverUrl}
                    title={b.title}
                    sizes="(max-width: 640px) 25vw, 120px"
                    priority={i < 4}
                  />
                  <span className="line-clamp-2 text-xs leading-tight">{b.title}</span>
                  <span className="text-[11px] text-green-700">
                    {b.availableInCluster} available
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-1">
        <h2 className="text-muted-foreground text-sm font-medium">Recently listed</h2>
        <BookResultList
          books={browse.recentlyListed}
          clusterSlug={cluster.slug}
          emptyMessage="No books listed yet. Be the first."
        />
      </section>
    </div>
  );
}
