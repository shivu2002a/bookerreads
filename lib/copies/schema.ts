import { z } from "zod";
import { LOAN_PERIOD_OPTIONS, MIN_BORROWER_TRUST_OPTIONS } from "./rules";

export const copyDetailsSchema = z.object({
  condition: z.enum(["like_new", "good", "worn"], { error: "Pick the condition." }),
  replacementValuePaise: z.coerce.number().int().min(100, "Enter a replacement value."),
  /** 0 means lend for free. Range is clamped server-side to config. */
  rentalPricePaise: z.coerce.number().int().min(0, "Enter a rental price."),
  loanPeriodDays: z.coerce
    .number()
    .int()
    .refine(
      (n) => (LOAN_PERIOD_OPTIONS as readonly number[]).includes(n),
      "Pick 14, 21, or 28 days.",
    ),
  allowedHandoffs: z
    .array(z.enum(["meetup", "courier"]))
    .min(1, "Pick at least one way to hand the book over."),
  minBorrowerTrust: z.coerce
    .number()
    .int()
    .refine(
      (n) => (MIN_BORROWER_TRUST_OPTIONS as readonly number[]).includes(n),
      "Invalid trust threshold.",
    ),
  notes: z.string().trim().max(300, "Keep notes under 300 characters.").optional().default(""),
});

export type CopyDetailsInput = z.infer<typeof copyDetailsSchema>;
