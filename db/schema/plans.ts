import { boolean, integer, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { baseColumns } from "./_shared";

/** Monthly subscription tiers (Requirement 4.1). Prices live here, not in code. */
export const plans = pgTable("plans", {
  ...baseColumns,
  code: text("code").notNull().unique(), // reader | regular | heavy
  name: text("name").notNull(),
  pricePaise: integer("price_paise").notNull(),
  concurrentLimit: smallint("concurrent_limit").notNull(),
  loanPeriodDays: smallint("loan_period_days").notNull(),
  razorpayPlanId: text("razorpay_plan_id"),
  active: boolean("active").notNull().default(true),
});
