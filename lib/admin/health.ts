import { desc, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { cronRuns } from "@/db/schema";

export type ClusterHealth = {
  membersByState: Record<string, number>;
  copiesByAvailability: Record<string, number>;
  copiesByVerification: Record<string, number>;
  requestsThisMonth: number;
  /** Requests that reached on_loan / requests, this month. */
  fillRate: number | null;
  medianRequestToHandoffHours: number | null;
  onTimeReturnRate: number | null;
  depositLiabilityPaise: number;
  payoutLiabilityPaise: number;
  recentCronRuns: Array<typeof cronRuns.$inferSelect>;
};

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : (r as { rows: T[] }).rows);
const toMap = (rows: Array<{ k: string; n: number | string }>) =>
  Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));

/** Requirement 13.5. One query per metric; all scoped to the cluster. */
export async function clusterHealth(
  db: DbOrTx,
  clusterId: string,
  now = new Date(),
): Promise<ClusterHealth> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [membersBy, copiesBy, verifiedBy, requests, handoff, onTime, liabilities, crons] =
    await Promise.all([
      db.execute(
        sql`select state as k, count(*) as n from members where cluster_id = ${clusterId} and deleted_at is null group by state`,
      ),
      db.execute(
        sql`select availability as k, count(*) as n from copies where cluster_id = ${clusterId} group by availability`,
      ),
      db.execute(
        sql`select verification_status as k, count(*) as n from copies where cluster_id = ${clusterId} and availability <> 'lost' group by verification_status`,
      ),
      db.execute(sql`
      select count(*) as total, count(*) filter (where handed_off_at is not null) as filled
      from loans l join copies c on c.id = l.copy_id
      where c.cluster_id = ${clusterId} and l.requested_at >= ${monthStart}`),
      db.execute(sql`
      select percentile_cont(0.5) within group (order by extract(epoch from (l.handed_off_at - l.requested_at)) / 3600) as median_h
      from loans l join copies c on c.id = l.copy_id
      where c.cluster_id = ${clusterId} and l.handed_off_at is not null and l.requested_at >= ${new Date(now.getTime() - 90 * 86_400_000)}`),
      db.execute(sql`
      select count(*) as total, count(*) filter (where l.returned_at <= l.due_at) as on_time
      from loans l join copies c on c.id = l.copy_id
      where c.cluster_id = ${clusterId} and l.returned_at is not null and l.due_at is not null and l.returned_at >= ${new Date(now.getTime() - 90 * 86_400_000)}`),
      db.execute(
        sql`select coalesce(sum(deposit_balance_paise),0) as deposit, coalesce(sum(payout_balance_paise),0) as payout from members where cluster_id = ${clusterId} and deleted_at is null`,
      ),
      db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).limit(7),
    ]);
  const req = rowsOf<{ total: string; filled: string }>(requests)[0];
  const med = rowsOf<{ median_h: string | null }>(handoff)[0];
  const ot = rowsOf<{ total: string; on_time: string }>(onTime)[0];
  const li = rowsOf<{ deposit: string; payout: string }>(liabilities)[0];
  return {
    membersByState: toMap(rowsOf(membersBy)),
    copiesByAvailability: toMap(rowsOf(copiesBy)),
    copiesByVerification: toMap(rowsOf(verifiedBy)),
    requestsThisMonth: Number(req.total),
    fillRate: Number(req.total) ? Number(req.filled) / Number(req.total) : null,
    medianRequestToHandoffHours: med.median_h === null ? null : Number(med.median_h),
    onTimeReturnRate: Number(ot.total) ? Number(ot.on_time) / Number(ot.total) : null,
    depositLiabilityPaise: Number(li.deposit),
    payoutLiabilityPaise: Number(li.payout),
    recentCronRuns: crons,
  };
}
