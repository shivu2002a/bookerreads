/**
 * design.md Pool run, as a pure function:
 *
 *   pool      = floor(revenue * pct / 100) + carry_in
 *   per_loan  = loans > 0 ? floor(pool / loans) : 0
 *   carry_out = pool - per_loan * loans
 *
 * Each lender is credited per_loan * their completed-loan count. The remainder
 * (always < loans, or the whole pool when there were no loans) carries forward.
 */

export type PoolInput = {
  revenuePaise: number;
  poolPct: number;
  carryInPaise: number;
  /** Completed loans in the month, by lender. */
  loanCounts: Map<string, number>;
};

export type PoolOutput = {
  poolPaise: number;
  loanCount: number;
  perLoanPaise: number;
  carryOutPaise: number;
  credits: Array<{ memberId: string; loanCount: number; creditPaise: number }>;
};

export function computePool(input: PoolInput): PoolOutput {
  if (!Number.isInteger(input.revenuePaise) || input.revenuePaise < 0)
    throw new RangeError("revenuePaise must be a non-negative integer");
  if (!Number.isInteger(input.carryInPaise) || input.carryInPaise < 0)
    throw new RangeError("carryInPaise must be a non-negative integer");
  if (input.poolPct < 0 || input.poolPct > 100) throw new RangeError("poolPct must be 0..100");

  const poolPaise = Math.floor((input.revenuePaise * input.poolPct) / 100) + input.carryInPaise;
  let loanCount = 0;
  for (const n of input.loanCounts.values()) loanCount += n;
  const perLoanPaise = loanCount > 0 ? Math.floor(poolPaise / loanCount) : 0;
  const carryOutPaise = poolPaise - perLoanPaise * loanCount;

  const credits = [...input.loanCounts]
    .filter(([, n]) => n > 0)
    .map(([memberId, n]) => ({ memberId, loanCount: n, creditPaise: n * perLoanPaise }))
    .sort((a, b) => a.memberId.localeCompare(b.memberId));

  return { poolPaise, loanCount, perLoanPaise, carryOutPaise, credits };
}
