import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { members, trustEvents } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import type { TrustEventKind } from "@/lib/loans/types";

export const TRUST_BASE = 50;
const MS_PER_MONTH = 30 * 24 * 3_600_000;

/** design.md Trust Score: clamp(50 + sum(deltas) + min(months, cap), 0, 100). Pure. */
export function computeTrustScore(input: {
  deltaSum: number;
  memberCreatedAt: Date;
  now: Date;
  ageBonusCapMonths: number;
}): number {
  const months = Math.floor((input.now.getTime() - input.memberCreatedAt.getTime()) / MS_PER_MONTH);
  const ageBonus = Math.min(Math.max(0, months), input.ageBonusCapMonths);
  return Math.max(0, Math.min(100, TRUST_BASE + input.deltaSum + ageBonus));
}

export function deltaFor(kind: TrustEventKind, weights: AppConfig["trust_weights"]): number {
  return weights[kind];
}

/**
 * Inserts the trust event with the delta from config and recomputes the
 * member's cached score from all their events (Requirement 9.2).
 */
export async function recordTrustEvent(
  tx: DbOrTx,
  input: { memberId: string; kind: TrustEventKind; loanId: string | null; now?: Date },
  config: AppConfig,
): Promise<{ delta: number; score: number }> {
  const now = input.now ?? new Date();
  const delta = deltaFor(input.kind, config.trust_weights);
  await tx.insert(trustEvents).values({
    memberId: input.memberId,
    kind: input.kind,
    loanId: input.loanId,
    delta,
    createdAt: now,
  });
  const score = await recomputeTrustScore(tx, input.memberId, config, now);
  return { delta, score };
}

export async function recomputeTrustScore(
  tx: DbOrTx,
  memberId: string,
  config: AppConfig,
  now = new Date(),
): Promise<number> {
  const [row] = await tx
    .select({
      createdAt: members.createdAt,
      deltaSum: sql<number>`coalesce((select sum(delta) from trust_events t where t.member_id = ${members}.id), 0)`,
    })
    .from(members)
    .where(eq(members.id, memberId));
  if (!row) throw new Error(`recomputeTrustScore: member ${memberId} not found`);
  const score = computeTrustScore({
    deltaSum: Number(row.deltaSum),
    memberCreatedAt: row.createdAt,
    now,
    ageBonusCapMonths: config.trust_weights.age_bonus_cap_months,
  });
  await tx.update(members).set({ trustScore: score }).where(eq(members.id, memberId));
  return score;
}
