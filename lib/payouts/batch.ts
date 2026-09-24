import { and, eq, gte, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db/client";
import { adminActions, events, members, notifications, payouts, poolRuns } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { postEntry } from "@/lib/ledger/post";

export type PayoutRow = typeof payouts.$inferSelect;

/**
 * Requirement 10.4: everyone at or above the threshold with a verified UPI id
 * gets a pending payout for their full balance. One batch per pool run;
 * re-running returns the existing batch.
 */
export async function generatePayoutBatch(
  db: Db,
  poolRunId: string,
  config: AppConfig,
  now = new Date(),
): Promise<{ batchId: string; created: number; payouts: PayoutRow[] }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ month: poolRuns.month })
      .from(poolRuns)
      .where(eq(poolRuns.id, poolRunId));
    if (!run) throw new Error(`pool run ${poolRunId} not found`);
    const batchId = `batch_${run.month.toISOString().slice(0, 7)}`;

    const existing = await tx.select().from(payouts).where(eq(payouts.batchId, batchId));
    if (existing.length) return { batchId, created: 0, payouts: existing };

    const eligible = await tx
      .select({ id: members.id, upiId: members.upiId, balance: members.payoutBalancePaise })
      .from(members)
      .where(
        and(
          eq(members.upiVerified, true),
          gte(members.payoutBalancePaise, config.payout_threshold_paise),
          sql`${members.upiId} is not null`,
          sql`${members.deletedAt} is null`,
        ),
      )
      .for("update");
    if (!eligible.length) return { batchId, created: 0, payouts: [] };

    const rows = await tx
      .insert(payouts)
      .values(
        eligible.map((m) => ({
          memberId: m.id,
          poolRunId,
          amountPaise: m.balance,
          upiId: m.upiId!,
          status: "pending" as const,
          batchId,
          createdAt: now,
        })),
      )
      .returning();
    await tx.insert(events).values({
      aggregate: "pool_run",
      aggregateId: poolRunId,
      type: "payout_batch.generated",
      payload: {
        batchId,
        count: rows.length,
        totalPaise: rows.reduce((a, r) => a + r.amountPaise, 0),
      },
      createdAt: now,
    });
    return { batchId, created: rows.length, payouts: rows };
  });
}

/**
 * RazorpayX bulk payout CSV (UPI mode). Columns follow the dashboard template;
 * the payout id goes in the reference so results can be matched back.
 */
export function payoutBatchCsv(
  rows: Array<{ id: string; amountPaise: number; upiId: string; memberId: string }>,
): string {
  const header = [
    "RazorpayX Account Number",
    "Amount",
    "Currency",
    "Mode",
    "Purpose",
    "Fund Account Id",
    "Fund Account Type",
    "Fund Account Vpa",
    "Contact Type",
    "Contact Reference Id",
    "Notes[payout_id]",
  ];
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      "", // account number filled by the operator when uploading
      (r.amountPaise / 100).toFixed(2),
      "INR",
      "UPI",
      "payout",
      "",
      "vpa",
      r.upiId,
      "vendor",
      r.memberId,
      r.id,
    ]
      .map(esc)
      .join(","),
  );
  return [header.map(esc).join(","), ...lines].join("\n") + "\n";
}

export async function markBatchExported(
  db: DbOrTx,
  batchId: string,
  now = new Date(),
): Promise<number> {
  const rows = await db
    .update(payouts)
    .set({ status: "exported", updatedAt: now })
    .where(and(eq(payouts.batchId, batchId), eq(payouts.status, "pending")))
    .returning({ id: payouts.id });
  return rows.length;
}

/**
 * Requirement 10.5: balances are marked paid only on confirmed success. A
 * failed payout leaves the balance for the next batch and records the reason.
 */
export async function markPayoutResult(
  db: Db,
  input: {
    payoutId: string;
    result: "paid" | "failed";
    razorpayPayoutId?: string | null;
    failureReason?: string | null;
    adminId: string;
    reason: string;
  },
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: "not_found" | "already_settled" }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(payouts).where(eq(payouts.id, input.payoutId)).for("update");
    if (!p) return { ok: false as const, error: "not_found" as const };
    if (p.status === "paid" || p.status === "failed")
      return { ok: false as const, error: "already_settled" as const };

    if (input.result === "paid") {
      await postEntry(tx, {
        memberId: p.memberId,
        account: "payout",
        kind: "payout_out",
        amountPaise: -p.amountPaise,
        payoutId: p.id,
        razorpayRef: input.razorpayPayoutId ?? null,
        note: `Payout ${p.batchId}`,
        actorId: input.adminId,
        createdAt: now,
      });
      await tx
        .update(payouts)
        .set({ status: "paid", razorpayPayoutId: input.razorpayPayoutId ?? null, updatedAt: now })
        .where(eq(payouts.id, p.id));
      await tx.insert(notifications).values({
        memberId: p.memberId,
        template: "payout_sent",
        channel: "whatsapp",
        payload: { amountPaise: p.amountPaise, upiId: p.upiId },
        status: "queued",
        createdAt: now,
      });
    } else {
      await tx
        .update(payouts)
        .set({ status: "failed", failureReason: input.failureReason ?? null, updatedAt: now })
        .where(eq(payouts.id, p.id));
    }
    await tx.insert(adminActions).values({
      adminId: input.adminId,
      targetType: "payout",
      targetId: p.id,
      action: `payout.${input.result}`,
      reason: input.reason,
      payload: { razorpayPayoutId: input.razorpayPayoutId ?? null },
      createdAt: now,
    });
    return { ok: true as const };
  });
}

export async function listBatch(db: DbOrTx, batchId: string) {
  return db.select().from(payouts).where(eq(payouts.batchId, batchId)).orderBy(payouts.createdAt);
}

export async function listBatches(db: DbOrTx) {
  return db
    .select({
      batchId: payouts.batchId,
      count: sql<number>`count(*)`,
      totalPaise: sql<number>`sum(${payouts.amountPaise})`,
      pending: sql<number>`count(*) filter (where ${payouts.status} in ('pending','exported'))`,
      createdAt: sql<Date>`min(${payouts.createdAt})`,
    })
    .from(payouts)
    .groupBy(payouts.batchId)
    .orderBy(sql`min(${payouts.createdAt}) desc`);
}
