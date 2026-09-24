import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clusters } from "@/db/schema";
import { getCurrentMember, type CurrentMember } from "@/lib/auth/current-member";
import { listOpenClusters } from "./queries";

export type ViewerContext = {
  member: CurrentMember | null;
  /** The cluster whose availability the viewer sees. */
  cluster: { id: string; slug: string; name: string } | null;
  /** Other open clusters a signed-out viewer may switch to. */
  openClusters: Array<{ id: string; slug: string; name: string }>;
  signedIn: boolean;
  onboarded: boolean;
};

/**
 * Requirement 3.4: signed-in members see their home cluster; visitors pick one
 * via `?c=slug` and otherwise get the first open cluster.
 */
export async function resolveViewerContext(clusterSlugParam?: string): Promise<ViewerContext> {
  const db = getDb();
  const [member, openClusters] = await Promise.all([getCurrentMember(), listOpenClusters(db)]);

  let cluster: ViewerContext["cluster"] = null;
  if (member?.clusterId) {
    const [c] = await db
      .select({ id: clusters.id, slug: clusters.slug, name: clusters.name })
      .from(clusters)
      .where(eq(clusters.id, member.clusterId));
    cluster = c ?? null;
  }
  if (!cluster && clusterSlugParam)
    cluster = openClusters.find((c) => c.slug === clusterSlugParam) ?? null;
  if (!cluster) cluster = openClusters[0] ?? null;

  return {
    member,
    cluster,
    openClusters,
    signedIn: Boolean(member),
    onboarded: Boolean(member?.displayName && member?.clusterId),
  };
}
