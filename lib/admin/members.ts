import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db/client";
import {
  adminActions,
  clusterWaitlist,
  clusters,
  copies,
  events,
  ledgerEntries,
  loans,
  members,
  notifications,
  trustEvents,
} from "@/db/schema";
import { hashPhone } from "@/lib/auth/phone-hash";
import { normaliseIndianMobile } from "@/lib/auth/phone";
import type { AppConfig } from "@/lib/config/schema";
import { postEntry } from "@/lib/ledger/post";
import { activateIfEligible } from "@/lib/members/membership";
import { enqueue } from "@/lib/notify/send";
import { adminAction } from "./act";

/** Requirement 13.2: lookup by phone (hashed) or display name. */
export async function searchMembers(db: DbOrTx, query: string, limit = 25) {
  const q = query.trim();
  const phone = normaliseIndianMobile(q);
  const where = phone
    ? eq(members.phoneHash, hashPhone(phone))
    : q
      ? ilike(members.displayName, `%${q}%`)
      : sql`true`;
  return db
    .select({
      id: members.id,
      displayName: members.displayName,
      state: members.state,
      trustScore: members.trustScore,
      deposit: members.depositBalancePaise,
      payout: members.payoutBalancePaise,
      createdAt: members.createdAt,
      deletedAt: members.deletedAt,
      cluster: clusters.name,
    })
    .from(members)
    .leftJoin(clusters, eq(clusters.id, members.clusterId))
    .where(where)
    .orderBy(desc(members.createdAt))
    .limit(limit);
}

export async function getMemberDetail(db: DbOrTx, memberId: string) {
  const [m] = await db
    .select({ member: members, cluster: clusters.name })
    .from(members)
    .leftJoin(clusters, eq(clusters.id, members.clusterId))
    .where(eq(members.id, memberId));
  if (!m) return null;
  const [copyRows, loanRows, ledger, trust, actions, notes] = await Promise.all([
    db
      .select({
        id: copies.id,
        availability: copies.availability,
        verificationStatus: copies.verificationStatus,
        createdAt: copies.createdAt,
      })
      .from(copies)
      .where(eq(copies.ownerId, memberId)),
    db
      .select({
        id: loans.id,
        state: loans.state,
        role: sql<string>`case when ${loans.lenderId} = ${memberId} then 'lender' else 'borrower' end`,
        requestedAt: loans.requestedAt,
      })
      .from(loans)
      .where(or(eq(loans.lenderId, memberId), eq(loans.borrowerId, memberId)))
      .orderBy(desc(loans.requestedAt))
      .limit(50),
    db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.memberId, memberId))
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(50),
    db
      .select()
      .from(trustEvents)
      .where(eq(trustEvents.memberId, memberId))
      .orderBy(desc(trustEvents.createdAt))
      .limit(50),
    db
      .select()
      .from(adminActions)
      .where(and(eq(adminActions.targetType, "member"), eq(adminActions.targetId, memberId)))
      .orderBy(desc(adminActions.createdAt))
      .limit(50),
    db
      .select()
      .from(notifications)
      .where(eq(notifications.memberId, memberId))
      .orderBy(desc(notifications.createdAt))
      .limit(20),
  ]);
  return { ...m, copies: copyRows, loans: loanRows, ledger, trust, actions, notifications: notes };
}

export async function suspendMember(
  db: Db,
  input: { adminId: string; memberId: string; untilDays: number; reason: string },
) {
  const until = new Date(Date.now() + input.untilDays * 86_400_000);
  return adminAction(
    db,
    {
      adminId: input.adminId,
      target: { type: "member", id: input.memberId },
      action: "member.suspend",
      reason: input.reason,
      payload: { until },
    },
    async (tx) => {
      await tx
        .update(members)
        .set({ state: "suspended", suspendedUntil: until })
        .where(eq(members.id, input.memberId));
      await tx.insert(events).values({
        aggregate: "member",
        aggregateId: input.memberId,
        type: "member.suspended",
        actorId: input.adminId,
        payload: { until: until.toISOString(), reason: input.reason },
      });
    },
  );
}

/** Back to `registered`; activation re-runs on the next deposit or listing. */
export async function reinstateMember(
  db: Db,
  input: { adminId: string; memberId: string; reason: string; config: AppConfig },
) {
  return adminAction(
    db,
    {
      adminId: input.adminId,
      target: { type: "member", id: input.memberId },
      action: "member.reinstate",
      reason: input.reason,
    },
    async (tx) => {
      await tx
        .update(members)
        .set({ state: "registered", suspendedUntil: null })
        .where(eq(members.id, input.memberId));
      await activateIfEligible(tx, input.memberId, input.config);
      await tx.insert(events).values({
        aggregate: "member",
        aggregateId: input.memberId,
        type: "member.reinstated",
        actorId: input.adminId,
        payload: {},
      });
    },
  );
}

export async function adjustDeposit(
  db: Db,
  input: { adminId: string; memberId: string; amountPaise: number; reason: string },
  config: AppConfig,
) {
  return adminAction(
    db,
    {
      adminId: input.adminId,
      target: { type: "member", id: input.memberId },
      action: "member.adjust_deposit",
      reason: input.reason,
      payload: { amountPaise: input.amountPaise },
    },
    async (tx) => {
      await postEntry(tx, {
        memberId: input.memberId,
        account: "deposit",
        kind: "adjustment",
        amountPaise: input.amountPaise,
        note: input.reason,
        actorId: input.adminId,
      });
      await tx
        .update(members)
        .set({ needsTopup: sql`${members.depositBalancePaise} < ${config.deposit_paise}` })
        .where(eq(members.id, input.memberId));
    },
  );
}

export async function addMemberNote(
  db: Db,
  input: { adminId: string; memberId: string; note: string },
) {
  return adminAction(
    db,
    {
      adminId: input.adminId,
      target: { type: "member", id: input.memberId },
      action: "member.note",
      reason: input.note,
    },
    async () => undefined,
  );
}

export async function setUpiVerified(
  db: Db,
  input: { adminId: string; memberId: string; verified: boolean; reason: string },
) {
  return adminAction(
    db,
    {
      adminId: input.adminId,
      target: { type: "member", id: input.memberId },
      action: input.verified ? "member.upi_verify" : "member.upi_unverify",
      reason: input.reason,
    },
    async (tx) => {
      await tx
        .update(members)
        .set({ upiVerified: input.verified })
        .where(eq(members.id, input.memberId));
    },
  );
}

/** Requirement 1.3: opening a cluster notifies its waitlist. */
export async function openCluster(
  db: Db,
  input: { adminId: string; clusterId: string; reason: string },
): Promise<number> {
  return adminAction(
    db,
    {
      adminId: input.adminId,
      target: { type: "cluster", id: input.clusterId },
      action: "cluster.open",
      reason: input.reason,
    },
    async (tx) => {
      const [c] = await tx
        .update(clusters)
        .set({ status: "open" })
        .where(eq(clusters.id, input.clusterId))
        .returning({ name: clusters.name });
      const waiting = await tx
        .select({ id: clusterWaitlist.id, memberId: clusterWaitlist.memberId })
        .from(clusterWaitlist)
        .where(
          and(eq(clusterWaitlist.clusterId, input.clusterId), isNull(clusterWaitlist.notifiedAt)),
        );
      for (const w of waiting) {
        await enqueue(tx, {
          memberId: w.memberId,
          template: "cluster_opened",
          vars: { cluster: c.name },
        });
        await tx
          .update(clusterWaitlist)
          .set({ notifiedAt: new Date() })
          .where(eq(clusterWaitlist.id, w.id));
      }
      return waiting.length;
    },
  );
}
