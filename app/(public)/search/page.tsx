import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { searchBooks } from "@/lib/search/queries";
import { resolveViewerContext } from "@/lib/search/viewer-cluster";
import { SearchBox } from "@/components/search-box";
import { ClusterSwitcher } from "@/components/cluster-switcher";

export const metadata: Metadata = { title: "Search" };
export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; c?: string }>;
}) {
  const { q = "", c } = await searchParams;
  const ctx = await resolveViewerContext(c);
  const initialResults =
    q.trim().length >= 2
      ? await searchBooks(getDb(), { query: q, clusterId: ctx.cluster?.id ?? null })
      : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        {ctx.cluster && !ctx.member?.clusterId && (
          <ClusterSwitcher current={ctx.cluster.slug} clusters={ctx.openClusters} />
        )}
      </div>
      {ctx.cluster && (
        <p className="text-muted-foreground text-sm">
          Showing what&apos;s available in{" "}
          <span className="text-foreground font-medium">{ctx.cluster.name}</span>.
        </p>
      )}
      <SearchBox
        clusterId={ctx.cluster?.id ?? null}
        clusterSlug={ctx.member?.clusterId ? undefined : ctx.cluster?.slug}
        initialQuery={q}
        initialResults={initialResults}
      />
    </div>
  );
}
