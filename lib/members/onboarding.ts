import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/db/client";
import { clusterWaitlist, clusters, events, members } from "@/db/schema";

/** Kept deliberately short; the public shelf shows this name (Requirement 3.5). */
const BLOCKED_NAME_WORDS = ["admin", "bookerreads", "support", "moderator"];

export const displayNameSchema = z
  .string()
  .trim()
  .min(2, "Use at least 2 characters.")
  .max(30, "Keep it under 30 characters.")
  .regex(/^[\p{L}\p{N} .'\-]+$/u, "Letters, numbers, spaces, and . ' - only.")
  .refine(
    (name) => !BLOCKED_NAME_WORDS.some((w) => name.toLowerCase().includes(w)),
    "That name isn't available.",
  );

export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^5[67]\d{4}$/, "Enter a Bangalore pincode (56xxxx or 57xxxx).");

export type OnboardingClusters = {
  open: Array<{ id: string; slug: string; name: string }>;
  waitlist: Array<{ id: string; slug: string; name: string }>;
};

export async function listClustersForOnboarding(db: DbOrTx): Promise<OnboardingClusters> {
  const rows = await db
    .select({ id: clusters.id, slug: clusters.slug, name: clusters.name, status: clusters.status })
    .from(clusters)
    .orderBy(clusters.name);
  return {
    open: rows.filter((c) => c.status === "open"),
    waitlist: rows.filter((c) => c.status === "waitlist"),
  };
}

export async function findClusterByPincode(db: DbOrTx, pincode: string) {
  const rows = await db
    .select({ id: clusters.id, slug: clusters.slug, name: clusters.name, status: clusters.status })
    .from(clusters)
    .where(sql`${pincode} = any(${clusters.pincodes})`)
    .limit(1);
  return rows[0] ?? null;
}

export type CompleteOnboardingError = "cluster_not_open" | "cluster_not_found";

/**
 * Sets display name and home cluster (Requirement 1.2). Only open clusters are
 * accepted; a closed cluster goes through joinWaitlist instead.
 */
export async function completeOnboarding(
  db: DbOrTx,
  input: { memberId: string; displayName: string; clusterId: string },
): Promise<{ ok: true } | { ok: false; error: CompleteOnboardingError }> {
  const [cluster] = await db
    .select({ id: clusters.id, status: clusters.status })
    .from(clusters)
    .where(eq(clusters.id, input.clusterId))
    .limit(1);
  if (!cluster) return { ok: false, error: "cluster_not_found" };
  if (cluster.status !== "open") return { ok: false, error: "cluster_not_open" };

  await db
    .update(members)
    .set({
      displayName: input.displayName,
      clusterId: input.clusterId,
      termsAcceptedAt: new Date(),
    })
    .where(eq(members.id, input.memberId));
  await db.insert(events).values({
    aggregate: "member",
    aggregateId: input.memberId,
    type: "member.onboarded",
    actorId: input.memberId,
    payload: { clusterId: input.clusterId },
  });
  return { ok: true };
}

/**
 * Requirement 1.3: a member whose area is not open yet joins that cluster's
 * waitlist. Their display name is saved so they can still list books; home
 * cluster stays unset until the cluster opens (they can also pick an open one).
 */
export async function joinWaitlist(
  db: DbOrTx,
  input: { memberId: string; displayName: string; pincode: string },
): Promise<
  | { ok: true; cluster: { id: string; name: string; status: "waitlist" | "open" | "paused" } }
  | { ok: false; error: "no_cluster_for_pincode" }
> {
  const cluster = await findClusterByPincode(db, input.pincode);
  if (!cluster) return { ok: false, error: "no_cluster_for_pincode" };

  await db
    .update(members)
    .set({ displayName: input.displayName })
    .where(eq(members.id, input.memberId));
  if (cluster.status !== "open") {
    await db
      .insert(clusterWaitlist)
      .values({ clusterId: cluster.id, memberId: input.memberId, pincode: input.pincode })
      .onConflictDoNothing();
    await db.insert(events).values({
      aggregate: "member",
      aggregateId: input.memberId,
      type: "member.waitlisted",
      actorId: input.memberId,
      payload: { clusterId: cluster.id, pincode: input.pincode },
    });
  }
  return { ok: true, cluster };
}

export async function isOnWaitlist(db: DbOrTx, memberId: string, clusterId: string) {
  const rows = await db
    .select({ id: clusterWaitlist.id })
    .from(clusterWaitlist)
    .where(and(eq(clusterWaitlist.memberId, memberId), eq(clusterWaitlist.clusterId, clusterId)))
    .limit(1);
  return rows.length > 0;
}
