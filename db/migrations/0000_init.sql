-- Extensions and helper functions (not tracked by drizzle-kit; keep at the top of the first migration)
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
-- array_to_string is STABLE, which Postgres rejects in generated columns. This wrapper is safe
-- because the result depends only on its arguments.
CREATE OR REPLACE FUNCTION immutable_array_to_string(text[], text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT array_to_string($1, $2) $$;--> statement-breakpoint
CREATE TYPE "public"."book_source" AS ENUM('google_books', 'open_library', 'manual');--> statement-breakpoint
CREATE TYPE "public"."cluster_status" AS ENUM('waitlist', 'open', 'paused');--> statement-breakpoint
CREATE TYPE "public"."copy_availability" AS ENUM('available', 'requested', 'on_loan', 'unlisted', 'lost');--> statement-breakpoint
CREATE TYPE "public"."copy_condition" AS ENUM('like_new', 'good', 'worn');--> statement-breakpoint
CREATE TYPE "public"."cron_job" AS ENUM('daily', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."decline_reason" AS ENUM('not_available', 'no_longer_have', 'other');--> statement-breakpoint
CREATE TYPE "public"."dispute_resolution" AS ENUM('dismissed', 'partial_charge', 'full_charge');--> statement-breakpoint
CREATE TYPE "public"."dispute_state" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."event_aggregate" AS ENUM('member', 'copy', 'loan', 'dispute', 'pool_run');--> statement-breakpoint
CREATE TYPE "public"."handoff_method" AS ENUM('meetup', 'drop_point', 'courier');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('deposit', 'payout');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('deposit_in', 'deposit_refund', 'deposit_charge', 'deposit_topup', 'pool_credit', 'lost_book_credit', 'payout_out', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."loan_party" AS ENUM('lender', 'borrower');--> statement-breakpoint
CREATE TYPE "public"."loan_phase" AS ENUM('out', 'return');--> statement-breakpoint
CREATE TYPE "public"."loan_state" AS ENUM('requested', 'declined', 'expired', 'accepted', 'on_loan', 'overdue', 'returned', 'lost', 'disputed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."member_state" AS ENUM('registered', 'active', 'lapsed', 'suspended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('whatsapp', 'sms');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sent', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('captured', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'exported', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trust_event_kind" AS ENUM('return_on_time', 'return_late', 'book_lost', 'dispute_lost', 'no_show', 'request_ignored', 'lend_completed', 'borrow_completed');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'verified');--> statement-breakpoint
CREATE TABLE "clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"pincodes" text[] DEFAULT '{}' NOT NULL,
	"status" "cluster_status" DEFAULT 'waitlist' NOT NULL,
	"launch_threshold_copies" integer DEFAULT 300 NOT NULL,
	"launch_threshold_members" integer DEFAULT 60 NOT NULL,
	CONSTRAINT "clusters_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"price_paise" integer NOT NULL,
	"concurrent_limit" smallint NOT NULL,
	"loan_period_days" smallint NOT NULL,
	"razorpay_plan_id" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "cluster_waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"pincode" text,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auth_user_id" uuid NOT NULL,
	"phone_hash" text NOT NULL,
	"display_name" text,
	"cluster_id" uuid,
	"state" "member_state" DEFAULT 'registered' NOT NULL,
	"suspended_until" timestamp with time zone,
	"plan_id" uuid,
	"razorpay_customer_id" text,
	"razorpay_subscription_id" text,
	"subscription_pending_since" timestamp with time zone,
	"deposit_balance_paise" integer DEFAULT 0 NOT NULL,
	"payout_balance_paise" integer DEFAULT 0 NOT NULL,
	"needs_topup" boolean DEFAULT false NOT NULL,
	"upi_id" text,
	"upi_verified" boolean DEFAULT false NOT NULL,
	"trust_score" smallint DEFAULT 50 NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"first_borrow_completed_at" timestamp with time zone,
	"terms_accepted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "members_auth_user_id_unique" UNIQUE("auth_user_id"),
	CONSTRAINT "members_phone_hash_unique" UNIQUE("phone_hash")
);
--> statement-breakpoint
CREATE TABLE "otp_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text NOT NULL,
	"phone_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"isbn13" text,
	"title" text NOT NULL,
	"authors" text[] DEFAULT '{}' NOT NULL,
	"publisher" text,
	"published_year" smallint,
	"language" text DEFAULT 'en' NOT NULL,
	"page_count" integer,
	"cover_url" text,
	"list_price_paise" integer,
	"source" "book_source" NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_photo_path" text,
	"merged_into_id" uuid,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("books"."title", '')), 'A') || setweight(to_tsvector('simple', immutable_array_to_string("books"."authors", ' ')), 'B')) STORED,
	CONSTRAINT "books_isbn13_unique" UNIQUE("isbn13")
);
--> statement-breakpoint
CREATE TABLE "copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"condition" "copy_condition" NOT NULL,
	"replacement_value_paise" integer NOT NULL,
	"listing_photo_path" text NOT NULL,
	"notes" text,
	"allowed_handoffs" "handoff_method"[] NOT NULL,
	"min_borrower_trust" smallint DEFAULT 0 NOT NULL,
	"availability" "copy_availability" DEFAULT 'available' NOT NULL,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"decline_count" smallint DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"still_have_it_pinged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drop_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"contact" text NOT NULL,
	"hours" jsonb NOT NULL,
	"capacity" smallint NOT NULL,
	"occupancy" smallint DEFAULT 0 NOT NULL,
	"qr_secret" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loan_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loan_id" uuid NOT NULL,
	"taken_by" uuid NOT NULL,
	"phase" "loan_phase" NOT NULL,
	"storage_path" text NOT NULL,
	"condition" "copy_condition"
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"copy_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"lender_id" uuid NOT NULL,
	"borrower_id" uuid NOT NULL,
	"state" "loan_state" DEFAULT 'requested' NOT NULL,
	"handoff_method" "handoff_method" NOT NULL,
	"drop_point_id" uuid,
	"handoff_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"out_lender_confirmed_at" timestamp with time zone,
	"out_borrower_confirmed_at" timestamp with time zone,
	"handed_off_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"extended" boolean DEFAULT false NOT NULL,
	"return_borrower_confirmed_at" timestamp with time zone,
	"return_lender_confirmed_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"return_condition" "copy_condition",
	"auto_confirmed_side" "loan_party",
	"decline_reason" "decline_reason",
	"pool_month" date,
	"last_reminder_on" date
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loan_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"state" "dispute_state" DEFAULT 'open' NOT NULL,
	"resolution" "dispute_resolution",
	"charge_paise" integer,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	CONSTRAINT "disputes_loan_id_unique" UNIQUE("loan_id")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"account" "ledger_account" NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"amount_paise" integer NOT NULL,
	"loan_id" uuid,
	"pool_run_id" uuid,
	"payout_id" uuid,
	"razorpay_ref" text,
	"note" text,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"pool_run_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"upi_id" text NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"razorpay_payout_id" text,
	"batch_id" text NOT NULL,
	"failure_reason" text
);
--> statement-breakpoint
CREATE TABLE "pool_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"month" date NOT NULL,
	"revenue_paise" integer NOT NULL,
	"pool_pct" smallint NOT NULL,
	"pool_paise" integer NOT NULL,
	"carry_in_paise" integer NOT NULL,
	"loan_count" integer NOT NULL,
	"per_loan_paise" integer NOT NULL,
	"carry_out_paise" integer NOT NULL,
	"statement" jsonb NOT NULL,
	CONSTRAINT "pool_runs_month_unique" UNIQUE("month")
);
--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"razorpay_payment_id" text NOT NULL,
	"razorpay_subscription_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"status" "payment_status" NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"pool_month" date NOT NULL,
	CONSTRAINT "subscription_payments_razorpay_payment_id_unique" UNIQUE("razorpay_payment_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admin_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "cron_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job" "cron_job" NOT NULL,
	"run_date" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"aggregate" "event_aggregate" NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"template" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"provider_ref" text,
	"loan_id" uuid,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failure_reason" text
);
--> statement-breakpoint
CREATE TABLE "trust_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" "trust_event_kind" NOT NULL,
	"loan_id" uuid,
	"delta" smallint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_waitlist" ADD CONSTRAINT "cluster_waitlist_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_waitlist" ADD CONSTRAINT "cluster_waitlist_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_merged_into_id_books_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copies" ADD CONSTRAINT "copies_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copies" ADD CONSTRAINT "copies_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copies" ADD CONSTRAINT "copies_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_points" ADD CONSTRAINT "drop_points_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_messages" ADD CONSTRAINT "loan_messages_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_messages" ADD CONSTRAINT "loan_messages_sender_id_members_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_photos" ADD CONSTRAINT "loan_photos_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_photos" ADD CONSTRAINT "loan_photos_taken_by_members_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_copy_id_copies_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."copies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_lender_id_members_id_fk" FOREIGN KEY ("lender_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_borrower_id_members_id_fk" FOREIGN KEY ("borrower_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_drop_point_id_drop_points_id_fk" FOREIGN KEY ("drop_point_id") REFERENCES "public"."drop_points"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_members_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_members_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_pool_run_id_pool_runs_id_fk" FOREIGN KEY ("pool_run_id") REFERENCES "public"."pool_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_actor_id_members_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_pool_run_id_pool_runs_id_fk" FOREIGN KEY ("pool_run_id") REFERENCES "public"."pool_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_admin_id_members_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config" ADD CONSTRAINT "config_updated_by_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_id_members_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_events" ADD CONSTRAINT "trust_events_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_events" ADD CONSTRAINT "trust_events_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_waitlist_member_uidx" ON "cluster_waitlist" USING btree ("cluster_id","member_id");--> statement-breakpoint
CREATE INDEX "members_cluster_state_idx" ON "members" USING btree ("cluster_id","state");--> statement-breakpoint
CREATE INDEX "members_display_name_idx" ON "members" USING btree ("display_name");--> statement-breakpoint
CREATE INDEX "otp_attempts_ip_created_idx" ON "otp_attempts" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "otp_attempts_phone_created_idx" ON "otp_attempts" USING btree ("phone_hash","created_at");--> statement-breakpoint
CREATE INDEX "books_search_vector_idx" ON "books" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "books_title_trgm_idx" ON "books" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "books_needs_review_idx" ON "books" USING btree ("needs_review") WHERE "books"."needs_review" = true;--> statement-breakpoint
CREATE INDEX "copies_cluster_book_availability_idx" ON "copies" USING btree ("cluster_id","book_id","availability");--> statement-breakpoint
CREATE INDEX "copies_owner_availability_idx" ON "copies" USING btree ("owner_id","availability");--> statement-breakpoint
CREATE INDEX "copies_last_activity_idx" ON "copies" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "drop_points_cluster_active_idx" ON "drop_points" USING btree ("cluster_id","active");--> statement-breakpoint
CREATE INDEX "loan_messages_loan_created_idx" ON "loan_messages" USING btree ("loan_id","created_at");--> statement-breakpoint
CREATE INDEX "loan_photos_loan_idx" ON "loan_photos" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "loans_borrower_state_idx" ON "loans" USING btree ("borrower_id","state");--> statement-breakpoint
CREATE INDEX "loans_lender_state_idx" ON "loans" USING btree ("lender_id","state");--> statement-breakpoint
CREATE INDEX "loans_state_due_idx" ON "loans" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "loans_pool_month_idx" ON "loans" USING btree ("pool_month");--> statement-breakpoint
CREATE INDEX "loans_copy_idx" ON "loans" USING btree ("copy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_one_open_per_copy_uidx" ON "loans" USING btree ("copy_id") WHERE "loans"."state" in ('requested', 'accepted', 'on_loan', 'overdue');--> statement-breakpoint
CREATE INDEX "disputes_state_created_idx" ON "disputes" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "ledger_member_account_idx" ON "ledger_entries" USING btree ("member_id","account");--> statement-breakpoint
CREATE INDEX "ledger_loan_idx" ON "ledger_entries" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "ledger_pool_run_idx" ON "ledger_entries" USING btree ("pool_run_id");--> statement-breakpoint
CREATE INDEX "payouts_batch_idx" ON "payouts" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "payouts_member_idx" ON "payouts" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "subscription_payments_pool_month_status_idx" ON "subscription_payments" USING btree ("pool_month","status");--> statement-breakpoint
CREATE INDEX "subscription_payments_member_idx" ON "subscription_payments" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uidx" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "admin_actions_target_idx" ON "admin_actions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "admin_actions_admin_idx" ON "admin_actions" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cron_runs_job_date_uidx" ON "cron_runs" USING btree ("job","run_date");--> statement-breakpoint
CREATE INDEX "events_aggregate_idx" ON "events" USING btree ("aggregate","aggregate_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_loan_template_created_idx" ON "notifications" USING btree ("loan_id","template","created_at");--> statement-breakpoint
CREATE INDEX "notifications_provider_ref_idx" ON "notifications" USING btree ("provider_ref");--> statement-breakpoint
CREATE INDEX "notifications_status_sent_idx" ON "notifications" USING btree ("status","sent_at");--> statement-breakpoint
CREATE INDEX "trust_events_member_idx" ON "trust_events" USING btree ("member_id","created_at");