import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { copies, members } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { formatPaise } from "@/lib/money";

export type ActivationCheck = { ok: boolean; label: string; hint: string };

export type ActivationStatus = {
  ok: boolean;
  checks: {
    deposit: ActivationCheck;
    borrowGate: ActivationCheck;
  };
  /** First failing hint, for the request guard message. */
  reason: string | null;
  counts: {
    listedCopies: number;
    depositPaise: number;
  };
};

/**
 * Requirement 4.3/4.4/4.7: a member may borrow when they hold the full deposit
 * and have at least `min_listed_copies` copies with photos in
 * available/requested/on_loan. Pure decision on top of two numbers, so it is
 * cheap to call from the request guard and from the activation page.
 */
export async function evaluateActivation(
  db: DbOrTx,
  memberId: string,
  config: AppConfig,
): Promise<ActivationStatus> {
  const [m] = await db
    .select({ state: members.state, deposit: members.depositBalancePaise })
    .from(members)
    .where(eq(members.id, memberId));
  if (!m) throw new Error(`evaluateActivation: member ${memberId} not found`);

  const [counts] = await db
    .select({
      listed: sql<number>`count(*) filter (where ${copies.availability} in ('available','requested','on_loan') and ${copies.listingPhotoPath} <> '')`,
    })
    .from(copies)
    .where(eq(copies.ownerId, memberId));

  const listedCopies = Number(counts.listed);
  const gate = config.borrow_gate;

  const deposit: ActivationCheck = {
    ok: m.deposit >= config.deposit_paise,
    label: `Refundable deposit of ${formatPaise(config.deposit_paise)}`,
    hint:
      m.deposit > 0
        ? `Top up ${formatPaise(config.deposit_paise - m.deposit)} to restore your deposit.`
        : "Pay the refundable deposit. You get it back when you leave.",
  };
  const missing = gate.min_listed_copies - listedCopies;
  const borrowGate: ActivationCheck = {
    ok: missing <= 0,
    label:
      gate.min_listed_copies === 1
        ? "List one book of your own"
        : `List ${gate.min_listed_copies} books of your own`,
    hint: `List ${missing} more book${missing === 1 ? "" : "s"} with a photo. Lending is what keeps the shelves full.`,
  };

  const checks = { deposit, borrowGate };
  const failing = Object.values(checks).find((c) => !c.ok);
  return {
    ok: !failing,
    checks,
    reason: failing?.hint ?? null,
    counts: { listedCopies, depositPaise: m.deposit },
  };
}
