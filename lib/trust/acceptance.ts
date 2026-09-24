/**
 * Requirement 9.5 / design.md: acceptance rate = accepted / (accepted +
 * declined + expired) over the lender's last 20 answered requests, shown once
 * they have answered at least 3. Pure; the DB query lives in
 * lib/members/public-profile.ts and lib/search/queries.ts.
 */

export const ACCEPTANCE_WINDOW = 20;
export const ACCEPTANCE_MIN_REQUESTS = 3;

export type AnsweredRequestState =
  | "declined"
  | "expired"
  | "accepted"
  | "on_loan"
  | "overdue"
  | "returned"
  | "lost"
  | "disputed"
  | "resolved";

/** `states` must be ordered newest first; anything past the window is ignored. */
export function acceptanceRate(states: AnsweredRequestState[]): {
  rate: number | null;
  answered: number;
} {
  const recent = states.slice(0, ACCEPTANCE_WINDOW);
  const answered = recent.length;
  if (answered < ACCEPTANCE_MIN_REQUESTS) return { rate: null, answered };
  const accepted = recent.filter((s) => s !== "declined" && s !== "expired").length;
  return { rate: accepted / answered, answered };
}
