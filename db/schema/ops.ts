import {
  date,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns, timestamptz } from "./_shared";
import {
  cronJob,
  eventAggregate,
  notificationChannel,
  notificationStatus,
  trustEventKind,
} from "./enums";
import { loans } from "./loans";
import { members } from "./members";

/** Inputs to the trust score. Score is recomputed from these with configurable weights. */
export const trustEvents = pgTable(
  "trust_events",
  {
    ...baseColumns,
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    kind: trustEventKind("kind").notNull(),
    loanId: uuid("loan_id").references(() => loans.id),
    /** Delta applied at the time of the event, from config.trust_weights. */
    delta: smallint("delta").notNull(),
  },
  (t) => [index("trust_events_member_idx").on(t.memberId, t.createdAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    ...baseColumns,
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    template: text("template").notNull(),
    channel: notificationChannel("channel").notNull(),
    payload: jsonb("payload").$type<Record<string, string | number>>().notNull(),
    status: notificationStatus("status").notNull().default("queued"),
    providerRef: text("provider_ref"),
    loanId: uuid("loan_id").references(() => loans.id),
    sentAt: timestamptz("sent_at"),
    deliveredAt: timestamptz("delivered_at"),
    failureReason: text("failure_reason"),
  },
  (t) => [
    // Once-per-day reminder dedupe looks up (loan, template, day).
    index("notifications_loan_template_created_idx").on(t.loanId, t.template, t.createdAt),
    index("notifications_provider_ref_idx").on(t.providerRef),
    index("notifications_status_sent_idx").on(t.status, t.sentAt),
  ],
);

/** Append-only audit of every domain transition. */
export const events = pgTable(
  "events",
  {
    ...baseColumns,
    aggregate: eventAggregate("aggregate").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    type: text("type").notNull(),
    actorId: uuid("actor_id").references(() => members.id),
    payload: jsonb("payload").notNull().default({}),
  },
  (t) => [index("events_aggregate_idx").on(t.aggregate, t.aggregateId, t.createdAt)],
);

/** Every admin mutation, with a mandatory reason (Requirement 15.6). */
export const adminActions = pgTable(
  "admin_actions",
  {
    ...baseColumns,
    adminId: uuid("admin_id")
      .notNull()
      .references(() => members.id),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    payload: jsonb("payload").notNull().default({}),
  },
  (t) => [
    index("admin_actions_target_idx").on(t.targetType, t.targetId),
    index("admin_actions_admin_idx").on(t.adminId, t.createdAt),
  ],
);

/** Runtime configuration editable from admin without a deployment. */
export const config = pgTable("config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description"),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => members.id),
});

/** One row per scheduled job per day; steps record their own outcome. */
export const cronRuns = pgTable(
  "cron_runs",
  {
    ...baseColumns,
    job: cronJob("job").notNull(),
    runDate: date("run_date", { mode: "date" }).notNull(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
    steps: jsonb("steps").$type<CronStepResult[]>().notNull().default([]),
  },
  (t) => [uniqueIndex("cron_runs_job_date_uidx").on(t.job, t.runDate)],
);

export type CronStepResult = {
  step: string;
  ok: boolean;
  count?: number;
  error?: string;
  durationMs: number;
};
