import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { members } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { enqueue } from "@/lib/notify/send";
import { generatePayoutBatch, previousMonthUtc } from "@/lib/payouts/batch";
import type { Step } from "./runner";

/**
 * 1st of the month, 03:00 IST: payout batch for lenders over the threshold.
 * Idempotent per month, so a retry on the same day is safe.
 */
export function monthlySteps(db: Db, config: AppConfig, now: Date): Step[] {
  return [
    {
      name: "payout_batch",
      run: async () => {
        const batch = await generatePayoutBatch(db, previousMonthUtc(now), config, now);
        if (batch.created > 0) {
          const admins = await db
            .select({ id: members.id })
            .from(members)
            .where(and(eq(members.isAdmin, true), isNull(members.deletedAt)));
          for (const a of admins) {
            await enqueue(db, {
              memberId: a.id,
              template: "payout_batch_ready",
              vars: {
                month: batch.batchId.replace("batch_", ""),
                count: batch.created,
                totalPaise: batch.payouts.reduce((s, p) => s + p.amountPaise, 0),
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
