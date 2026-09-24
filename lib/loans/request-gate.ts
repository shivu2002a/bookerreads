/**
 * Decides how the request CTA renders for a copy on the book page
 * (Requirements 3.4, 4.2, 9.3, 9.4). Pure; extended in Phase 5 with the
 * membership gates (deposit, listing gate, suspension, concurrent limit).
 */

export type GateViewer = {
  signedIn: boolean;
  onboarded: boolean;
  memberId: string | null;
  clusterId: string | null;
  trustScore: number | null;
  state: "registered" | "active" | "suspended" | "cancelled" | null;
};

export type GateCopy = {
  id: string;
  ownerId: string;
  clusterId: string;
  availability: "available" | "on_loan";
  minBorrowerTrust: number;
};

export type GateDecision =
  /** Render the request button. */
  | { kind: "request" }
  /** Render a sign-in link in place of the button. */
  | { kind: "sign_in" }
  /** Member has not finished onboarding. */
  | { kind: "onboard" }
  /** Do not render any CTA (Requirement 9.4: hide when below the copy's minimum). */
  | { kind: "hidden" }
  /** Render a disabled button with a hint. */
  | {
      kind: "blocked";
      reason:
        | "own_copy"
        | "on_loan"
        | "other_cluster"
        | "needs_activation"
        | "trust_floor"
        | "suspended"

      hint: string;
    };

export function decideRequestGate(
  viewer: GateViewer,
  copy: GateCopy,
  globalTrustFloor: number,
): GateDecision {
  if (copy.availability === "on_loan")
    return { kind: "blocked", reason: "on_loan", hint: "Out on loan right now." };
  if (!viewer.signedIn) return { kind: "sign_in" };
  if (!viewer.onboarded) return { kind: "onboard" };
  if (viewer.memberId === copy.ownerId)
    return { kind: "blocked", reason: "own_copy", hint: "This is your copy." };
  if (viewer.clusterId !== copy.clusterId)
    return {
      kind: "blocked",
      reason: "other_cluster",
      hint: "Only members of this area can borrow it.",
    };

  const trust = viewer.trustScore ?? 0;
  if (copy.minBorrowerTrust > 0 && trust < copy.minBorrowerTrust) return { kind: "hidden" };
  if (trust < globalTrustFloor) {
    return {
      kind: "blocked",
      reason: "trust_floor",
      hint: `Your trust score is below ${globalTrustFloor}. Lend a few books to recover it.`,
    };
  }
  if (viewer.state === "suspended")
    return {
      kind: "blocked",
      reason: "suspended",
      hint: "Your account is suspended from borrowing for now.",
    };
  // Registered and cancelled members go through activation at request time (Requirement 4.2).
  if (viewer.state !== "active")
    return {
      kind: "blocked",
      reason: "needs_activation",
      hint: "Pay the refundable deposit and list a book to start borrowing.",
    };
  return { kind: "request" };
}
