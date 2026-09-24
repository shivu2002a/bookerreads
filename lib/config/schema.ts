import { z } from "zod";

/**
 * Runtime configuration stored in the `config` table and editable from admin
 * without a deployment (Requirements 4.1, 9.2, 10.1). Each key has a Zod
 * schema so a bad admin edit is rejected before it is saved, and a default
 * that the seed writes and the loader falls back to.
 */

export const trustWeightsSchema = z.object({
  return_on_time: z.number().int(),
  return_late: z.number().int(),
  book_lost: z.number().int(),
  dispute_lost: z.number().int(),
  no_show: z.number().int(),
  request_ignored: z.number().int(),
  lend_completed: z.number().int(),
  borrow_completed: z.number().int(),
  /** Maximum months of account age that count toward the score. */
  age_bonus_cap_months: z.number().int().min(0),
});

export const borrowGateSchema = z.object({
  /** Copies with photos in available or on_loan (Requirement 4.4). */
  min_listed_copies: z.number().int().min(0),
  /** Below this trust score borrowing is blocked (Requirement 9.3). */
  min_trust_score: z.number().int().min(0).max(100),
});

export const configSchemas = {
  /** Share of each rental retained by the platform (Requirement 10.1). */
  platform_fee_pct: z.number().int().min(0).max(100),
  deposit_paise: z.number().int().min(0),
  /** Hours a borrower has to pay after the lender accepts (Requirement 5). */
  payment_window_hours: z.number().int().min(1),
  /** Open loans (requested/accepted/on_loan/overdue) a borrower may hold at once. */
  max_open_loans: z.number().int().min(1),
  /** Rental price bounds a lister may choose (paise). */
  rental_price_min_paise: z.number().int().min(0),
  rental_price_max_paise: z.number().int().min(0),
  payout_threshold_paise: z.number().int().min(0),
  trust_weights: trustWeightsSchema,
  borrow_gate: borrowGateSchema,
  request_timeout_hours: z.number().int().min(1),
  handoff_timeout_days: z.number().int().min(1),
  handoff_nudge_hours: z.number().int().min(1),
  handoff_auto_confirm_hours: z.number().int().min(1),
  extension_days: z.number().int().min(1),
  due_soon_reminder_days: z.number().int().min(0),
  overdue_to_lost_days: z.number().int().min(1),
  overdue_reminder_days: z.number().int().min(0),
  lost_suspension_days: z.number().int().min(0),
  dispute_window_hours: z.number().int().min(1),
  new_account_listing_cap: z.number().int().min(0),
  new_account_age_days: z.number().int().min(0),
  copy_decline_unlist_threshold: z.number().int().min(1),
  drop_point_uncollected_alert_days: z.number().int().min(1),
  still_have_it_after_days: z.number().int().min(1),
  still_have_it_unlist_after_days: z.number().int().min(1),
  /** Public meet-up spots per cluster slug, suggested at handoff. */
  meetup_spots: z.record(z.string(), z.array(z.string())),
} as const;

export type ConfigKey = keyof typeof configSchemas;
export type ConfigValue<K extends ConfigKey> = z.infer<(typeof configSchemas)[K]>;
export type AppConfig = { [K in ConfigKey]: ConfigValue<K> };

export const CONFIG_DEFAULTS: AppConfig = {
  platform_fee_pct: 15,
  deposit_paise: 50000,
  payment_window_hours: 24,
  max_open_loans: 2,
  rental_price_min_paise: 0,
  rental_price_max_paise: 20000,
  payout_threshold_paise: 20000,
  trust_weights: {
    return_on_time: 2,
    return_late: -4,
    book_lost: -25,
    dispute_lost: -10,
    no_show: -6,
    request_ignored: -2,
    lend_completed: 2,
    borrow_completed: 1,
    age_bonus_cap_months: 6,
  },
  borrow_gate: {
    min_listed_copies: 1,
    min_trust_score: 30,
  },
  request_timeout_hours: 48,
  handoff_timeout_days: 5,
  handoff_nudge_hours: 48,
  handoff_auto_confirm_hours: 72,
  extension_days: 7,
  due_soon_reminder_days: 3,
  overdue_to_lost_days: 14,
  overdue_reminder_days: 14,
  lost_suspension_days: 90,
  dispute_window_hours: 48,
  new_account_listing_cap: 10,
  new_account_age_days: 7,
  copy_decline_unlist_threshold: 3,
  drop_point_uncollected_alert_days: 5,
  still_have_it_after_days: 90,
  still_have_it_unlist_after_days: 14,
  meetup_spots: {
    "central-east": [
      "Third Wave Coffee, 12th Main Indiranagar",
      "Blossom Book House, Church Street",
      "Koramangala 3rd Block park gate",
      "Indiranagar Metro station entrance",
    ],
  },
};

export const CONFIG_DESCRIPTIONS: Record<ConfigKey, string> = {
  platform_fee_pct: "Share of each rental price kept by the platform (%)",
  deposit_paise: "Refundable deposit required to borrow (paise)",
  payment_window_hours: "Hours the borrower has to pay after the lender accepts",
  max_open_loans: "Open loans a borrower may hold at once",
  rental_price_min_paise: "Lowest rental price a lister may set (paise)",
  rental_price_max_paise: "Highest rental price a lister may set (paise)",
  payout_threshold_paise: "Minimum payout balance to be included in a batch (paise)",
  trust_weights: "Trust score delta per event kind and age bonus cap",
  borrow_gate: "Listing and trust requirements before a member can borrow",
  request_timeout_hours: "Hours before an unanswered request expires",
  handoff_timeout_days: "Days an accepted loan may wait for handoff before expiring",
  handoff_nudge_hours: "Hours after a one-sided confirmation before nudging the other party",
  handoff_auto_confirm_hours: "Hours after a one-sided confirmation before auto-confirming",
  extension_days: "Days added by the borrower's one free extension",
  due_soon_reminder_days: "Days before due date to send the due-soon reminder",
  overdue_to_lost_days: "Days overdue before a loan is marked lost",
  overdue_reminder_days: "Number of daily overdue reminders to send",
  lost_suspension_days: "Days a borrower is suspended after losing a book",
  dispute_window_hours: "Hours after return during which a dispute may be opened",
  new_account_listing_cap: "Maximum copies for accounts younger than new_account_age_days",
  new_account_age_days: "Age in days below which an account is considered new",
  copy_decline_unlist_threshold: "Declines or expiries before a copy is auto-unlisted",
  drop_point_uncollected_alert_days: "Days a copy may sit at a drop point before alerting",
  still_have_it_after_days: "Days of inactivity before asking a lender if they still have a copy",
  still_have_it_unlist_after_days:
    "Days without a reply to the still-have-it ping before unlisting",
  meetup_spots: "Suggested public meet-up spots per cluster slug",
};

export function parseConfigValue<K extends ConfigKey>(key: K, value: unknown): ConfigValue<K> {
  return configSchemas[key].parse(value) as ConfigValue<K>;
}
