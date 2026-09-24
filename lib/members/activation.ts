import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { copies, loans, members, plans } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { formatPaise } from "@/lib/money";

export type ActivationCheck = { ok: boolean; label: string; hint: string };

export type ActivationStatus = {
  ok: boolean;
  checks: {
    subscription: ActivationCheck;
    deposit: ActivationCheck;
    borrowGate: ActivationCheck;
  };
  /** First failing hint, for the request guard message. */
  reason: string | null;
  counts: {
    listedCopies: number;
    verifiedCopies: number;
    completedLends: number;
    depositPaise: number;
  };
};

/**
 * Requirement 4.3/4.4/4.7: a member may borrow when they have an active plan,
 * hold the full deposit, and pass the borrow gate (>= 3 listed copies with
 * photos in available/on_loan AND (>= 1 verified copy OR >= 1 completed lend)).
 * Pure decision on top of a few counts, so it is cheap to call from the
 * request guard and from the activation page.
 */
export async function evaluateActivation(
  db: DbOrTx,
  memberId: string,
  config: AppConfig,
): Promise<ActivationStatus> {
  const [m] = await db
    .select({
      state: members.state,
      planId: members.planId,
      deposit: members.depositBalancePaise,
      planActive: plans.active,
    })
    .from(members)
    .leftJoin(plans, eq(plans.id, members.planId))
    .where(eq(members.id, memberId));
  if (!m) throw new Error(`evaluateActivation: member ${memberId} not found`);

  const [counts] = await db
    .select({
      listed: sql<number>`count(*) filter (where ${copies.availability} in ('available','requested','on_loan') and ${copies.listingPhotoPath} <> '')`,
      verified: sql<number>`count(*) filter (where ${copies.verificationStatus} = 'verified' and ${copies.availability} <> 'lost')`,
    })
    .from(copies)
    .where(eq(copies.ownerId, memberId));
  const [{ lends }] = await db
    .select({ lends: sql<number>`count(*)` })
    .from(loans)
    .where(
      and(eq(loans.lenderId, memberId), inArray(loans.state, ["returned", "disputed", "resolved"])),
    );

  const listedCopies = Number(counts.listed);
  const verifiedCopies = Number(counts.verified);
  const completedLends = Number(lends);
  const gate = config.borrow_gate;

  const subscription: ActivationCheck = {
    ok: Boolean(m.planId && m.planActive && m.state === "active"),
    label: "Monthly plan",
    hint:
      m.state === "lapsed"
        ? "Your plan has lapsed. Renew to continue borrowing."
        : "Choose a plan to start borrowing.",
  };
  const deposit: ActivationCheck = {
    ok: m.deposit >= config.deposit_paise,
    label: `Deposit of ${formatPaise(config.deposit_paise)}`,
    hint:
      m.deposit > 0
        ? `Top up ${formatPaise(config.deposit_paise - m.deposit)} to restore your deposit.`
        : "Pay the refundable deposit.",
  };
  const gateListedOk = listedCopies >= gate.min_listed_copies;
  const gateProofOk = !gate.require_verified_or_lend || verifiedCopies >= 1 || completedLends >= 1;
  const borrowGate: ActivationCheck = {
    ok: gateListedOk && gateProofOk,
    label: `List ${gate.min_listed_copies} books, one verified or lent`,
    hint: !gateListedOk
      ? `List ${gate.min_listed_copies - listedCopies} more book${gate.min_listed_copies - listedCopies === 1 ? "" : "s"} with photos.`
      : "Get one copy verified (lend it once, or have it checked at a drop point or event).",
  };

  const checks = { subscription, deposit, borrowGate };
  const failing = Object.values(checks).find((c) => !c.ok);
  return {
    ok: !failing,
    checks,
    reason: failing?.hint ?? null,
    counts: { listedCopies, verifiedCopies, completedLends, depositPaise: m.deposit },
  };
}
