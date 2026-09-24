import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { ledgerEntries, members } from "@/db/schema";

export type LedgerAccount = "deposit" | "payout";
export type LedgerKind = (typeof ledgerEntries.$inferInsert)["kind"];

export type PostEntryInput = {
  memberId: string;
  account: LedgerAccount;
  kind: LedgerKind;
  /** Signed. Positive increases the balance. */
  amountPaise: number;
  loanId?: string | null;
  poolRunId?: string | null;
  payoutId?: string | null;
  razorpayRef?: string | null;
  note?: string | null;
  actorId?: string | null;
  createdAt?: Date;
};

export type PostEntryResult = {
  entryId: string;
  /** Balance after this entry. */
  balancePaise: number;
  /** For deposit charges that could not be fully covered: the uncovered amount. */
  shortfallPaise: number;
};

export class LedgerError extends Error {
  constructor(
    readonly code: "insufficient_balance" | "invalid_amount",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Appends a ledger row and updates the member's cached balance in the same
 * statement sequence (design.md ledger_entries). Callers must already be in a
 * transaction; the member row is locked so two postings cannot race.
 *
 * Deposits never go negative: a `deposit_charge` larger than the balance is
 * clamped to the balance and the remainder is returned as `shortfallPaise`
 * (Requirement 7.4 / design.md Lost book). Every other debit that would
 * overdraw throws.
 */
export async function postEntry(tx: DbOrTx, input: PostEntryInput): Promise<PostEntryResult> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise === 0) {
    throw new LedgerError("invalid_amount", "Ledger amounts must be non-zero integers (paise).");
  }

  const [locked] = await tx
    .select({ deposit: members.depositBalancePaise, payout: members.payoutBalancePaise })
    .from(members)
    .where(eq(members.id, input.memberId))
    .for("update");
  if (!locked) throw new Error(`postEntry: member ${input.memberId} not found`);

  const current = input.account === "deposit" ? locked.deposit : locked.payout;
  let amount = input.amountPaise;
  let shortfall = 0;

  if (amount < 0 && current + amount < 0) {
    if (input.account === "deposit" && input.kind === "deposit_charge") {
      shortfall = -(current + amount);
      amount = -current;
      if (amount === 0) {
        // Nothing to charge; still return the shortfall so the caller can record it.
        return { entryId: "", balancePaise: current, shortfallPaise: shortfall };
      }
    } else {
      throw new LedgerError(
        "insufficient_balance",
        `Balance ${current} cannot absorb ${amount} on ${input.account}.`,
      );
    }
  }

  const [row] = await tx
    .insert(ledgerEntries)
    .values({
      memberId: input.memberId,
      account: input.account,
      kind: input.kind,
      amountPaise: amount,
      loanId: input.loanId ?? null,
      poolRunId: input.poolRunId ?? null,
      payoutId: input.payoutId ?? null,
      razorpayRef: input.razorpayRef ?? null,
      note: input.note ?? null,
      actorId: input.actorId ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: ledgerEntries.id });

  const next = current + amount;
  await tx
    .update(members)
    .set(input.account === "deposit" ? { depositBalancePaise: next } : { payoutBalancePaise: next })
    .where(eq(members.id, input.memberId));

  return { entryId: row.id, balancePaise: next, shortfallPaise: shortfall };
}

/** Recomputes both cached balances from the ledger. Used by `pnpm ledger:check` and tests. */
export async function recomputeBalances(
  tx: DbOrTx,
  memberId: string,
): Promise<{ deposit: number; payout: number }> {
  const [sums] = await tx
    .select({
      deposit: sql<number>`coalesce(sum(case when ${ledgerEntries.account} = 'deposit' then ${ledgerEntries.amountPaise} end), 0)`,
      payout: sql<number>`coalesce(sum(case when ${ledgerEntries.account} = 'payout' then ${ledgerEntries.amountPaise} end), 0)`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.memberId, memberId));
  const deposit = Number(sums.deposit);
  const payout = Number(sums.payout);
  await tx
    .update(members)
    .set({ depositBalancePaise: deposit, payoutBalancePaise: payout })
    .where(eq(members.id, memberId));
  return { deposit, payout };
}
