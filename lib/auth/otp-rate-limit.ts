import { createHash } from "node:crypto";
import { and, gt, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { otpAttempts } from "@/db/schema";

/**
 * Requirement 15.5: at most 3 OTP sends per phone per 10 minutes and 10 per IP
 * per hour. Supabase Auth has its own global ceiling; this is the per-number
 * and per-IP layer, backed by the otp_attempts table so it works across
 * serverless instances.
 */

export const OTP_LIMITS = {
  perPhone: { max: 3, windowMs: 10 * 60 * 1000 },
  perIp: { max: 10, windowMs: 60 * 60 * 1000 },
} as const;

export type OtpLimitDecision =
  { allowed: true } | { allowed: false; reason: "phone" | "ip"; retryAfterMs: number };

/**
 * Pure decision from the timestamps of previous attempts. `now` and the
 * attempt lists are supplied by the caller so this is trivially testable.
 */
export function decideOtpLimit(
  now: Date,
  phoneAttempts: Date[],
  ipAttempts: Date[],
  limits = OTP_LIMITS,
): OtpLimitDecision {
  const inWindow = (attempts: Date[], windowMs: number) =>
    attempts
      .filter((t) => now.getTime() - t.getTime() < windowMs)
      .sort((a, b) => a.getTime() - b.getTime());

  const phone = inWindow(phoneAttempts, limits.perPhone.windowMs);
  if (phone.length >= limits.perPhone.max) {
    const oldest = phone[phone.length - limits.perPhone.max];
    return {
      allowed: false,
      reason: "phone",
      retryAfterMs: oldest.getTime() + limits.perPhone.windowMs - now.getTime(),
    };
  }
  const ip = inWindow(ipAttempts, limits.perIp.windowMs);
  if (ip.length >= limits.perIp.max) {
    const oldest = ip[ip.length - limits.perIp.max];
    return {
      allowed: false,
      reason: "ip",
      retryAfterMs: oldest.getTime() + limits.perIp.windowMs - now.getTime(),
    };
  }
  return { allowed: true };
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip.trim()).digest("hex");
}

/** First hop of x-forwarded-for, or a stable placeholder when unknown. */
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Checks the limits and, when allowed, records the attempt in the same
 * transaction so two concurrent requests cannot both slip under the cap.
 */
export async function checkAndRecordOtpAttempt(
  db: DbOrTx,
  input: { phoneHash: string; ipHash: string; now?: Date },
): Promise<OtpLimitDecision> {
  const now = input.now ?? new Date();
  const since = new Date(
    now.getTime() - Math.max(OTP_LIMITS.perPhone.windowMs, OTP_LIMITS.perIp.windowMs),
  );

  return db.transaction(async (tx) => {
    // Serialise attempts for this phone and IP.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.phoneHash})), pg_advisory_xact_lock(hashtext(${input.ipHash}))`,
    );

    const recent = await tx
      .select({
        phoneHash: otpAttempts.phoneHash,
        ipHash: otpAttempts.ipHash,
        at: otpAttempts.createdAt,
      })
      .from(otpAttempts)
      .where(
        and(
          gt(otpAttempts.createdAt, since),
          sql`(${otpAttempts.phoneHash} = ${input.phoneHash} or ${otpAttempts.ipHash} = ${input.ipHash})`,
        ),
      );

    const decision = decideOtpLimit(
      now,
      recent.filter((r) => r.phoneHash === input.phoneHash).map((r) => r.at),
      recent.filter((r) => r.ipHash === input.ipHash).map((r) => r.at),
    );
    if (decision.allowed) {
      await tx
        .insert(otpAttempts)
        .values({ phoneHash: input.phoneHash, ipHash: input.ipHash, createdAt: now });
    }
    return decision;
  });
}

/** Housekeeping for the daily cron: drop attempts older than the longest window. */
export async function pruneOtpAttempts(db: DbOrTx, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 2 * OTP_LIMITS.perIp.windowMs);
  const deleted = await db
    .delete(otpAttempts)
    .where(sql`${otpAttempts.createdAt} < ${cutoff}`)
    .returning({ id: otpAttempts.id });
  return deleted.length;
}
