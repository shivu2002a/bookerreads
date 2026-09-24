/**
 * Pure listing rules. No Zod here: this module is imported by client islands
 * and must stay small. Validation schemas live in ./schema.ts.
 */
/**
 * Replacement value is a fixed range of ₹100–₹1000 regardless of catalogue
 * price (Requirement 2.4). The catalogue price only seeds the default.
 */
export const MIN_REPLACEMENT_PAISE = 10_000;
export const MAX_REPLACEMENT_PAISE = 100_000;
/** Fallback when the catalogue has no price. */
export const DEFAULT_REPLACEMENT_PAISE = 39900;
export const MIN_BORROWER_TRUST_OPTIONS = [0, 30, 50, 70] as const;
/** Loan periods a lister may choose (Requirement 2.4). */
export const LOAN_PERIOD_OPTIONS = [14, 21, 28] as const;
export const DEFAULT_LOAN_PERIOD_DAYS = 21;
/** Fallback rental price shown in the wizard when nothing sticky exists (₹30). */
export const DEFAULT_RENTAL_PRICE_PAISE = 3000;

/** Clamp a lister's rental price into the configured range, rounded to whole rupees. */
export function clampRentalPrice(valuePaise: number, minPaise: number, maxPaise: number): number {
  return Math.min(maxPaise, Math.max(minPaise, roundToRupee(valuePaise)));
}

/** floor(rental × pct / 100): what the platform keeps from one rental (Requirement 10.1). */
export function platformFee(rentalPaise: number, pct: number): number {
  return Math.floor((rentalPaise * pct) / 100);
}

/** Round to whole rupees so the slider and the stored value agree. */
const roundToRupee = (p: number) => Math.round(p / 100) * 100;

export function replacementBounds(listPricePaise: number | null): {
  min: number;
  max: number;
  def: number;
} {
  const seed = roundToRupee(listPricePaise ?? DEFAULT_REPLACEMENT_PAISE);
  return {
    min: MIN_REPLACEMENT_PAISE,
    max: MAX_REPLACEMENT_PAISE,
    def: Math.min(MAX_REPLACEMENT_PAISE, Math.max(MIN_REPLACEMENT_PAISE, seed)),
  };
}

export function clampReplacement(valuePaise: number, listPricePaise: number | null): number {
  const { min, max } = replacementBounds(listPricePaise);
  return Math.min(max, Math.max(min, roundToRupee(valuePaise)));
}

/**
 * Requirement 2.6: accounts younger than `newAccountAgeDays` may list at most
 * `cap` copies. Returns how many more they may add (Infinity when unrestricted).
 */
export function remainingListingAllowance(input: {
  memberCreatedAt: Date;
  now: Date;
  currentCopyCount: number;
  newAccountAgeDays: number;
  cap: number;
}): number {
  const ageMs = input.now.getTime() - input.memberCreatedAt.getTime();
  const isNew = ageMs < input.newAccountAgeDays * 86_400_000;
  if (!isNew) return Number.POSITIVE_INFINITY;
  return Math.max(0, input.cap - input.currentCopyCount);
}

/** Only copies that are not committed to a loan can be unlisted (Requirement 2.7). */
export function canUnlist(
  availability: "available" | "requested" | "on_loan" | "unlisted" | "lost",
): boolean {
  return availability === "available";
}

export function canRelist(
  availability: "available" | "requested" | "on_loan" | "unlisted" | "lost",
): boolean {
  return availability === "unlisted";
}
