import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { members } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { enqueue } from "@/lib/notify/send";
import { generatePayoutBatch } from "@/lib/payouts/batch";
import { previousMonthUtc, runPool } from "@/lib/pool/run";
import type { Step } from "./runner";

/**
 * 1st of the month, 03:00 IST: pool run for the previous month, then the
 * payout batch. Both are idempotent, so a retry on the same day is safe.
 */
export function monthlySteps(db: Db, config: AppConfig, now: Date): Step[] {
  let poolRunId: string | null = null;
  return [
    {
      name: "pool_run",
      run: async () => {
        const res = await runPool(db, previousMonthUtc(now), config, now);
        poolRunId = res.poolRunId;
        return res.statement.loanCount;
      },
    },
    {
      name: "payout_batch",
      run: async () => {
        if (!poolRunId) throw new Error("pool_run did not produce a run id");
        const batch = await generatePayoutBatch(db, poolRunId, config, now);
        if (batch.created > 0) {
          const admins = await db
            .select({ id: members.id })
            .from(members)
            .where(and(eq(members.isAdmin, true), isNull(members.deletedAt)));
          for (const a of admins) {
            await enqueue(db, {
              memberId: a.id,
              template: "pool_statement",
              vars: {
                month: batch.batchId.replace("batch_", ""),
                loans: batch.created,
                creditPaise: batch.payouts.reduce((s, p) => s + p.amountPaise, 0),
                link: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/admin/payouts`,
              },
              now,
            });
          }
        }
        return batch.created;
      },
    },
  ];
}
