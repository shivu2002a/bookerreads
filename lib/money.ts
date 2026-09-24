/**
 * Money helpers. All amounts in the system are integer paise.
 */

const PAISE_PER_RUPEE = 100;

export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) throw new RangeError("rupees must be finite");
  return Math.round(rupees * PAISE_PER_RUPEE);
}

export function paiseToRupees(paise: number): number {
  return paise / PAISE_PER_RUPEE;
}

/** Formats paise as an Indian rupee string, e.g. 75000 -> "₹750". */
export function formatPaise(paise: number, opts: { showPaise?: boolean } = {}): string {
  const rupees = paise / PAISE_PER_RUPEE;
  const hasFraction = paise % PAISE_PER_RUPEE !== 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: opts.showPaise || hasFraction ? 2 : 0,
    minimumFractionDigits: opts.showPaise || hasFraction ? 2 : 0,
  }).format(rupees);
}
