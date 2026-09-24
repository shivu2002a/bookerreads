-- Rental model: per-loan pricing replaces plans, subscriptions and the monthly pool.
-- Hand-ordered from the drizzle-kit diff so enum recreation, data carry-over and
-- table drops happen in a valid sequence. Pre-launch data: legacy rows are remapped
-- rather than preserved in detail.

-- 1. Payouts: key by month instead of pool run (carry the month over first).
ALTER TABLE "payouts" ADD COLUMN "month" date;--> statement-breakpoint
UPDATE "payouts" p SET "month" = pr."month" FROM "pool_runs" pr WHERE pr."id" = p."pool_run_id";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "month" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_pool_run_id_pool_runs_id_fk";--> statement-breakpoint
ALTER TABLE "payouts" DROP COLUMN "pool_run_id";--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_member_month_uidx" ON "payouts" USING btree ("member_id","month");--> statement-breakpoint

-- 2. Ledger: drop the pool link; remap pool credits to adjustments before the enum shrinks.
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_pool_run_id_pool_runs_id_fk";--> statement-breakpoint
DROP INDEX "ledger_pool_run_idx";--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP COLUMN "pool_run_id";--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
UPDATE "ledger_entries" SET "kind" = 'adjustment', "note" = coalesce("note", '') || ' [legacy pool credit]' WHERE "kind" = 'pool_credit';--> statement-breakpoint
DROP TYPE "public"."ledger_kind";--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('deposit_in', 'deposit_refund', 'deposit_charge', 'deposit_topup', 'rental_credit', 'lost_book_credit', 'payout_out', 'adjustment');--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_kind" USING "kind"::"public"."ledger_kind";--> statement-breakpoint

-- 3. Events: no more pool_run aggregate.
DELETE FROM "events" WHERE "aggregate" = 'pool_run';--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "aggregate" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."event_aggregate";--> statement-breakpoint
CREATE TYPE "public"."event_aggregate" AS ENUM('member', 'copy', 'loan', 'dispute');--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "aggregate" SET DATA TYPE "public"."event_aggregate" USING "aggregate"::"public"."event_aggregate";--> statement-breakpoint

-- 4. Members: drop plan/subscription columns; `lapsed` members fall back to registered.
ALTER TABLE "members" DROP CONSTRAINT "members_plan_id_plans_id_fk";--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "plan_id";--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "razorpay_subscription_id";--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "subscription_pending_since";--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "state" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "state" SET DEFAULT 'registered'::text;--> statement-breakpoint
UPDATE "members" SET "state" = 'registered' WHERE "state" = 'lapsed';--> statement-breakpoint
DROP TYPE "public"."member_state";--> statement-breakpoint
CREATE TYPE "public"."member_state" AS ENUM('registered', 'active', 'suspended', 'cancelled');--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "state" SET DEFAULT 'registered'::"public"."member_state";--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "state" SET DATA TYPE "public"."member_state" USING "state"::"public"."member_state";--> statement-breakpoint

-- 5. Drop the subscription-era tables (their RLS policies go with them).
DROP TABLE "subscription_payments" CASCADE;--> statement-breakpoint
DROP TABLE "pool_runs" CASCADE;--> statement-breakpoint
DROP TABLE "plans" CASCADE;--> statement-breakpoint

-- 6. payment_status now describes a loan rental order.
DROP TYPE "public"."payment_status";--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('created', 'captured', 'refund_pending', 'refunded', 'failed');--> statement-breakpoint

-- 7. Copies: lister-set price and period.
ALTER TABLE "copies" ADD COLUMN "rental_price_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "copies" ADD COLUMN "loan_period_days" smallint DEFAULT 21 NOT NULL;--> statement-breakpoint

-- 8. Loans: price snapshot and payment timestamps.
DROP INDEX "loans_pool_month_idx";--> statement-breakpoint
ALTER TABLE "loans" DROP COLUMN "pool_month";--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "rental_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "platform_fee_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "payment_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
-- Existing loans predate pricing: treat anything past `requested` as paid at acceptance.
UPDATE "loans" SET "paid_at" = coalesce("responded_at", "requested_at") WHERE "state" NOT IN ('requested', 'declined');--> statement-breakpoint
CREATE INDEX "loans_state_payment_due_idx" ON "loans" USING btree ("state","payment_due_at");--> statement-breakpoint

-- 9. Loan payments: one row per Razorpay order.
CREATE TABLE "loan_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loan_id" uuid NOT NULL,
	"borrower_id" uuid NOT NULL,
	"razorpay_order_id" text NOT NULL,
	"razorpay_payment_id" text,
	"amount_paise" integer NOT NULL,
	"status" "payment_status" DEFAULT 'created' NOT NULL,
	"paid_at" timestamp with time zone,
	"razorpay_refund_id" text,
	"refunded_at" timestamp with time zone,
	"failure_reason" text,
	CONSTRAINT "loan_payments_razorpay_order_id_unique" UNIQUE("razorpay_order_id"),
	CONSTRAINT "loan_payments_razorpay_payment_id_unique" UNIQUE("razorpay_payment_id")
);
--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_borrower_id_members_id_fk" FOREIGN KEY ("borrower_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_payments_loan_idx" ON "loan_payments" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "loan_payments_status_idx" ON "loan_payments" USING btree ("status");--> statement-breakpoint
ALTER TABLE "loan_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY loan_payments_read_own ON loan_payments FOR SELECT TO authenticated
  USING (borrower_id = public.current_member_id() OR public.is_admin());
