import { and, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { books, copies, dropPoints, events, loans, members, notifications } from "@/db/schema";
import { pruneOtpAttempts } from "@/lib/auth/otp-rate-limit";
import type { AppConfig } from "@/lib/config/schema";
import { applyLoanEvent } from "@/lib/loans/persist";
import type { LoanEvent } from "@/lib/loans/types";
import { enqueue, sweepUndelivered, type NotifyDeps } from "@/lib/notify/send";
import { processPendingRefunds } from "@/lib/payments/rental";
import type { RazorpayClient } from "@/lib/payments/razorpay";
import type { Step } from "./runner";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SYSTEM = { kind: "system" as const };

/**
 * Feeds each candidate loan to the machine. The machine's guards are the
 * source of truth for timing; `too_early` and `invalid_transition` are
 * expected for edge rows and are not errors.
 */
async function applyToEach(
  db: Db,
  ids: string[],
  event: LoanEvent,
  config: AppConfig,
  now: Date,
): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const res = await applyLoanEvent(db, id, event, SYSTEM, config, { now: () => now });
    if (res.ok) n++;
    else if (
      res.error.code !== "too_early" &&
      res.error.code !== "invalid_transition" &&
      res.error.code !== "already_confirmed_by_both"
    ) {
      throw new Error(`loan ${id} ${event.type}: ${res.error.code}`);
    }
  }
  return n;
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

export type DailyDeps = {
  /** Razorpay refunds API; the cron route passes the real client, tests pass a stub. */
  razorpay?: Pick<RazorpayClient, "createRefund">;
};

export function dailySteps(
  db: Db,
  config: AppConfig,
  notify: NotifyDeps,
  now: Date,
  deps: DailyDeps = {},
): Step[] {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const isoDay = now.toISOString().slice(0, 10);

  return [
    {
      name: "expire_requests",
      run: async () =>
        applyToEach(
          db,
          ids(
            await db
              .select({ id: loans.id })
              .from(loans)
              .where(
                and(
                  eq(loans.state, "requested"),
                  lte(loans.requestedAt, ago(config.request_timeout_hours * HOUR)),
                ),
              ),
          ),
          { type: "timeout" },
          config,
          now,
        ),
    },
    {
      // One side confirmed the handoff >= nudge window ago and the other has not: remind the other.
      name: "nudge_handoff",
      run: async () => {
        const rows = await db
          .select({
            id: loans.id,
            lenderId: loans.lenderId,
            borrowerId: loans.borrowerId,
            outL: loans.outLenderConfirmedAt,
            outB: loans.outBorrowerConfirmedAt,
          })
          .from(loans)
          .where(
            and(
              eq(loans.state, "accepted"),
              sql`(${loans.outLenderConfirmedAt} is null) <> (${loans.outBorrowerConfirmedAt} is null)`,
              sql`coalesce(${loans.outLenderConfirmedAt}, ${loans.outBorrowerConfirmedAt}) <= ${ago(config.handoff_nudge_hours * HOUR)}`,
            ),
          );
        let n = 0;
        for (const r of rows) {
          const target = r.outL ? r.borrowerId : r.lenderId;
          if (
            await enqueue(db, {
              memberId: target,
              template: "handoff_nudge",
              vars: {},
              loanId: r.id,
              now,
            })
          )
            n++;
        }
        return n;
      },
    },
    {
      name: "auto_confirm_handoff",
      run: async () =>
        applyToEach(
          db,
          ids(
            await db
              .select({ id: loans.id })
              .from(loans)
              .where(
                and(
                  eq(loans.state, "accepted"),
                  sql`(${loans.outLenderConfirmedAt} is null) <> (${loans.outBorrowerConfirmedAt} is null)`,
                  sql`coalesce(${loans.outLenderConfirmedAt}, ${loans.outBorrowerConfirmedAt}) <= ${ago(config.handoff_auto_confirm_hours * HOUR)}`,
                ),
              ),
          ),
          { type: "auto_confirm_out" },
          config,
          now,
        ),
    },
    {
      // Requirement 5: accepted but unpaid past the payment window. The machine
      // distinguishes this from a handoff no-show by `paid_at`.
      name: "expire_unpaid",
      run: async () =>
        applyToEach(
          db,
          ids(
            await db
              .select({ id: loans.id })
              .from(loans)
              .where(
                and(
                  eq(loans.state, "accepted"),
                  isNull(loans.paidAt),
                  lte(loans.paymentDueAt, now),
                ),
              ),
          ),
          { type: "timeout" },
          config,
          now,
        ),
    },
    {
      name: "expire_handoffs",
      run: async () =>
        applyToEach(
          db,
          ids(
            await db
              .select({ id: loans.id })
              .from(loans)
              .where(
                and(
                  eq(loans.state, "accepted"),
                  isNotNull(loans.paidAt),
                  sql`not (${loans.outLenderConfirmedAt} is not null and ${loans.outBorrowerConfirmedAt} is not null)`,
                  lte(
                    sql`coalesce(${loans.respondedAt}, ${loans.requestedAt})`,
                    ago(config.handoff_timeout_days * DAY),
                  ),
                ),
              ),
          ),
          { type: "timeout" },
          config,
          now,
        ),
    },
    {
      name: "mark_overdue",
      run: async () =>
        applyToEach(
          db,
          ids(
            await db
              .select({ id: loans.id })
              .from(loans)
              .where(and(eq(loans.state, "on_loan"), lt(loans.dueAt, now))),
          ),
          { type: "overdue_tick" },
          config,
          now,
        ),
    },
    {
      name: "mark_lost",
      run: async () =>
        applyToEach(
          db,
          ids(
            await db
              .select({ id: loans.id })
              .from(loans)
              .where(
                and(
                  eq(loans.state, "overdue"),
                  lte(loans.dueAt, ago(config.overdue_to_lost_days * DAY)),
                ),
              ),
          ),
          { type: "lost_tick" },
          config,
          now,
        ),
    },
    {
      name: "nudge_return",
      run: async () => {
        const rows = await db
          .select({
            id: loans.id,
            lenderId: loans.lenderId,
            borrowerId: loans.borrowerId,
            retL: loans.returnLenderConfirmedAt,
          })
          .from(loans)
          .where(
            and(
              inArray(loans.state, ["on_loan", "overdue"]),
              sql`(${loans.returnLenderConfirmedAt} is null) <> (${loans.returnBorrowerConfirmedAt} is null)`,
              sql`coalesce(${loans.returnLenderConfirmedAt}, ${loans.returnBorrowerConfirmedAt}) <= ${ago(config.handoff_nudge_hours * HOUR)}`,
            ),
          );
        let n = 0;
        for (const r of rows) {
          if (
            await enqueue(db, {
              memberId: r.retL ? r.borrowerId : r.lenderId,
              template: "return_nudge",
              vars: {},
              loanId: r.id,
              now,
            })
          )
            n++;
        }
        return n;
      },
    },
    {
      name: "auto_confirm_return",
      run: async () =>
        applyToEach(
          db,
          ids(
            await db
              .select({ id: loans.id })
              .from(loans)
              .where(
                and(
                  inArray(loans.state, ["on_loan", "overdue"]),
                  sql`(${loans.returnLenderConfirmedAt} is null) <> (${loans.returnBorrowerConfirmedAt} is null)`,
                  sql`coalesce(${loans.returnLenderConfirmedAt}, ${loans.returnBorrowerConfirmedAt}) <= ${ago(config.handoff_auto_confirm_hours * HOUR)}`,
                ),
              ),
          ),
          { type: "auto_confirm_return" },
          config,
          now,
        ),
    },
    {
      // Requirement 7.1: one reminder when due_at is `due_soon_reminder_days` away (that calendar day).
      name: "remind_due_soon",
      run: async () => {
        const target = new Date(now.getTime() + config.due_soon_reminder_days * DAY);
        const dayStart = new Date(
          Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()),
        );
        const dayEnd = new Date(dayStart.getTime() + DAY);
        const rows = await db
          .select({ id: loans.id, borrowerId: loans.borrowerId })
          .from(loans)
          .where(
            and(
              eq(loans.state, "on_loan"),
              sql`${loans.dueAt} >= ${dayStart} and ${loans.dueAt} < ${dayEnd}`,
            ),
          );
        let n = 0;
        for (const r of rows)
          if (
            await enqueue(db, {
              memberId: r.borrowerId,
              template: "due_soon",
              vars: {},
              loanId: r.id,
              now,
            })
          )
            n++;
        return n;
      },
    },
    {
      // Requirement 7.3: one per day for `overdue_reminder_days` days; enqueue dedupes within the day.
      name: "remind_overdue",
      run: async () => {
        const rows = await db
          .select({ id: loans.id, borrowerId: loans.borrowerId })
          .from(loans)
          .where(
            and(
              eq(loans.state, "overdue"),
              sql`${loans.dueAt} > ${ago(config.overdue_reminder_days * DAY)}`,
            ),
          );
        let n = 0;
        for (const r of rows)
          if (
            await enqueue(db, {
              memberId: r.borrowerId,
              template: "overdue",
              vars: {},
              loanId: r.id,
              now,
            })
          )
            n++;
        return n;
      },
    },
    { name: "sms_fallback_sweep", run: () => sweepUndelivered(db, { ...notify, now: () => now }) },
    {
      // Rentals flagged by the machine after a paid handoff expired (Requirement 6.6).
      name: "process_refunds",
      run: async () => {
        if (!deps.razorpay) return 0;
        const res = await processPendingRefunds(db, deps.razorpay, now);
        return res.refunded;
      },
    },
    {
      // Requirement 12.4: copy dropped at a venue and not collected for > N days.
      name: "alert_uncollected_drop_points",
      run: async () => {
        const rows = await db
          .select({ id: loans.id, lenderId: loans.lenderId, venue: dropPoints.name })
          .from(loans)
          .innerJoin(dropPoints, eq(dropPoints.id, loans.dropPointId))
          .where(
            sql`(
              (${loans.state} = 'accepted' and ${loans.outLenderConfirmedAt} is not null and ${loans.outBorrowerConfirmedAt} is null and ${loans.outLenderConfirmedAt} <= ${ago(config.drop_point_uncollected_alert_days * DAY)})
              or (${loans.state} in ('on_loan','overdue') and ${loans.returnBorrowerConfirmedAt} is not null and ${loans.returnLenderConfirmedAt} is null and ${loans.returnBorrowerConfirmedAt} <= ${ago(config.drop_point_uncollected_alert_days * DAY)})
            )`,
          );
        const admins = await db
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.isAdmin, true), isNull(members.deletedAt)));
        let n = 0;
        for (const r of rows) {
          // The daily dedupe on this template keeps it to one alert per loan per day.
          if (
            await enqueue(db, {
              memberId: r.lenderId,
              template: "drop_point_uncollected",
              vars: { venue: r.venue },
              loanId: r.id,
              now,
            })
          )
            n++;
          for (const a of admins)
            await enqueue(db, {
              memberId: a.id,
              template: "drop_point_uncollected",
              vars: { venue: r.venue },
              loanId: r.id,
              now,
            });
        }
        return n;
      },
    },
    {
      // "Still have it?" for copies idle 90+ days; the owner relisting or any activity resets it.
      name: "ping_still_have_it",
      run: async () => {
        const rows = await db
          .select({ id: copies.id, ownerId: copies.ownerId, title: books.title })
          .from(copies)
          .innerJoin(books, eq(books.id, copies.bookId))
          .where(
            and(
              eq(copies.availability, "available"),
              lte(copies.lastActivityAt, ago(config.still_have_it_after_days * DAY)),
              sql`(${copies.stillHaveItPingedAt} is null or ${copies.stillHaveItPingedAt} <= ${ago(config.still_have_it_after_days * DAY)})`,
            ),
          )
          .limit(200);
        for (const r of rows) {
          await enqueue(db, {
            memberId: r.ownerId,
            template: "still_have_it",
            vars: { book: r.title },
            now,
          });
          await db.update(copies).set({ stillHaveItPingedAt: now }).where(eq(copies.id, r.id));
        }
        return rows.length;
      },
    },
    {
      // No reply (no activity) within the window after a ping: unlist.
      name: "unlist_unanswered_pings",
      run: async () => {
        const rows = await db
          .update(copies)
          .set({ availability: "unlisted", lastActivityAt: now })
          .where(
            and(
              eq(copies.availability, "available"),
              isNotNull(copies.stillHaveItPingedAt),
              lte(copies.stillHaveItPingedAt, ago(config.still_have_it_unlist_after_days * DAY)),
              sql`${copies.lastActivityAt} <= ${copies.stillHaveItPingedAt}`,
            ),
          )
          .returning({ id: copies.id, ownerId: copies.ownerId });
        for (const r of rows) {
          await db.insert(events).values({
            aggregate: "copy",
            aggregateId: r.id,
            type: "copy.auto_unlisted",
            payload: { reason: "still_have_it_unanswered" },
            createdAt: now,
          });
          await enqueue(db, { memberId: r.ownerId, template: "copy_auto_unlisted", vars: {}, now });
        }
        return rows.length;
      },
    },
    {
      // Belt and braces for Requirement 5.8: any available copy at/over the decline threshold.
      name: "unlist_declined_copies",
      run: async () => {
        const rows = await db
          .update(copies)
          .set({ availability: "unlisted", lastActivityAt: now })
          .where(
            and(
              eq(copies.availability, "available"),
              sql`${copies.declineCount} >= ${config.copy_decline_unlist_threshold}`,
            ),
          )
          .returning({ id: copies.id, ownerId: copies.ownerId });
        for (const r of rows) {
          await db.insert(events).values({
            aggregate: "copy",
            aggregateId: r.id,
            type: "copy.auto_unlisted",
            payload: { reason: "decline_threshold" },
            createdAt: now,
          });
          await enqueue(db, { memberId: r.ownerId, template: "copy_auto_unlisted", vars: {}, now });
        }
        return rows.length;
      },
    },
    { name: "prune_otp_attempts", run: () => pruneOtpAttempts(db, now) },
    {
      name: "prune_stale_notifications_marker",
      // Records the day in the log; real pruning of old notification rows is deferred until volume warrants it.
      run: async () => {
        await db
          .select({ n: sql<number>`count(*)` })
          .from(notifications)
          .where(sql`${notifications.createdAt} < ${ago(90 * DAY)}`);
        void isoDay;
      },
    },
  ];
}
