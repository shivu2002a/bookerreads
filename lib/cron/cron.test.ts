import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  books,
  clusters,
  copies,
  cronRuns,
  loans,
  members,
  notifications,
  plans,
  poolRuns,
  payouts,
  ledgerEntries,
} from "@/db/schema";
import { CONFIG_DEFAULTS } from "@/lib/config/schema";
import { mockProviders } from "@/lib/notify/providers";
import type { NotifyDeps } from "@/lib/notify/send";
import { createTestDb, type TestDb } from "@/test/db";
import { dailySteps } from "./daily";
import { monthlySteps } from "./monthly";
import { runCronJob } from "./runner";

const NOW = new Date("2026-09-21T20:30:00Z");
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const config = CONFIG_DEFAULTS;

let db: TestDb;
let close: () => Promise<void>;
let clusterId: string;
let bookId: string;
let lender: string;
let borrower: string;
const notify: NotifyDeps = {
  ...mockProviders(() => {}),
  phoneFor: async () => "919999900001",
  appUrl: "https://app.test",
  now: () => NOW,
};

async function member(name: string, extra: Partial<typeof members.$inferInsert> = {}) {
  const [m] = await db
    .insert(members)
    .values({
      authUserId: crypto.randomUUID(),
      phoneHash: name,
      displayName: name,
      clusterId,
      state: "active",
      trustScore: 60,
      depositBalancePaise: 75000,
      firstBorrowCompletedAt: new Date("2026-01-01"),
      createdAt: new Date("2026-01-01"),
      ...extra,
    })
    .returning();
  await db
    .insert(ledgerEntries)
    .values({ memberId: m.id, account: "deposit", kind: "deposit_in", amountPaise: 75000 });
  return m.id;
}

async function loanAt(
  state: "requested" | "accepted" | "on_loan" | "overdue",
  over: Partial<typeof loans.$inferInsert> = {},
) {
  const [c] = await db
    .insert(copies)
    .values({
      bookId,
      ownerId: lender,
      clusterId,
      condition: "good",
      replacementValuePaise: 30000,
      listingPhotoPath: "p",
      allowedHandoffs: ["meetup"],
      availability: state === "requested" || state === "accepted" ? "requested" : "on_loan",
    })
    .returning();
  const [l] = await db
    .insert(loans)
    .values({
      copyId: c.id,
      bookId,
      lenderId: lender,
      borrowerId: borrower,
      state,
      handoffMethod: "meetup",
      requestedAt: ago(10 * D),
      ...over,
    })
    .returning();
  return l.id;
}

const stateOf = async (id: string) =>
  (await db.select({ s: loans.state }).from(loans).where(eq(loans.id, id)))[0].s;
const notes = (loanId: string, template: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.loanId, loanId), eq(notifications.template, template)));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [{ id: clusterId }] = await db
    .insert(clusters)
    .values({ slug: "ce", name: "CE", pincodes: [], status: "open" })
    .returning({ id: clusters.id });
  const [plan] = await db
    .insert(plans)
    .values({
      code: "regular",
      name: "Regular",
      pricePaise: 24900,
      concurrentLimit: 5,
      loanPeriodDays: 21,
    })
    .returning();
  [{ id: bookId }] = await db
    .insert(books)
    .values({ isbn13: "9780062316097", title: "Sapiens", authors: ["H"], source: "google_books" })
    .returning({ id: books.id });
  lender = await member("lender", { planId: plan.id });
  borrower = await member("borrower", { planId: plan.id });
});
afterAll(() => close());

describe("daily job", () => {
  let req47: string,
    req49: string,
    acc71: string,
    acc73: string,
    acc6d: string,
    due3: string,
    due4: string,
    pastDue: string,
    lost13: string,
    lost15: string;

  beforeAll(async () => {
    req47 = await loanAt("requested", { requestedAt: ago(47 * H) });
    req49 = await loanAt("requested", { requestedAt: ago(49 * H) });
    acc71 = await loanAt("accepted", {
      respondedAt: ago(3 * D),
      outLenderConfirmedAt: ago(71 * H),
    });
    acc73 = await loanAt("accepted", {
      respondedAt: ago(4 * D),
      outLenderConfirmedAt: ago(73 * H),
    });
    acc6d = await loanAt("accepted", { respondedAt: ago(6 * D) });
    due3 = await loanAt("on_loan", {
      handedOffAt: ago(18 * D),
      dueAt: new Date(NOW.getTime() + 3 * D + 2 * H),
    });
    due4 = await loanAt("on_loan", {
      handedOffAt: ago(17 * D),
      dueAt: new Date(NOW.getTime() + 4 * D + 2 * H),
    });
    pastDue = await loanAt("on_loan", { handedOffAt: ago(22 * D), dueAt: ago(1 * H) });
    lost13 = await loanAt("overdue", { handedOffAt: ago(34 * D), dueAt: ago(13 * D) });
    lost15 = await loanAt("overdue", { handedOffAt: ago(36 * D), dueAt: ago(15 * D) });
  });

  it("applies exactly the expected transitions at each boundary", async () => {
    const out = await runCronJob(db, "daily", dailySteps(db, config, notify, NOW), { now: NOW });
    expect(out.status, JSON.stringify(out.steps.filter((s) => !s.ok))).toBe("completed");

    expect(await stateOf(req47)).toBe("requested");
    expect(await stateOf(req49)).toBe("expired");
    expect(await stateOf(acc71)).toBe("accepted");
    expect(await stateOf(acc73)).toBe("on_loan");
    expect(await stateOf(acc6d)).toBe("expired");
    expect(await stateOf(pastDue)).toBe("overdue");
    expect(await stateOf(lost13)).toBe("overdue");
    expect(await stateOf(lost15)).toBe("lost");

    // Reminders: due in 3 days yes, 4 days no; overdue gets one; the 71h one-sided handoff gets a nudge.
    expect(await notes(due3, "due_soon")).toHaveLength(1);
    expect(await notes(due4, "due_soon")).toHaveLength(0);
    expect((await notes(pastDue, "overdue")).length).toBeGreaterThanOrEqual(1);
    expect(await notes(acc71, "handoff_nudge")).toHaveLength(1);

    const steps = Object.fromEntries(out.steps.map((s) => [s.step, s.count]));
    expect(steps.expire_requests).toBe(1);
    expect(steps.auto_confirm_handoff).toBe(1);
    expect(steps.expire_handoffs).toBe(1);
    expect(steps.mark_overdue).toBe(1);
    expect(steps.mark_lost).toBe(1);
  });

  it("running again the same day is a no-op, and forcing it creates no duplicate reminders", async () => {
    const before = await db.select({ n: sql<number>`count(*)` }).from(notifications);
    const again = await runCronJob(db, "daily", dailySteps(db, config, notify, NOW), { now: NOW });
    expect(again.status).toBe("already_ran");
    const forced = await runCronJob(
      db,
      "daily",
      dailySteps(db, config, notify, new Date(NOW.getTime() + 60_000)),
      { now: new Date(NOW.getTime() + 60_000), force: true },
    );
    expect(forced.status).toBe("completed");
    const after = await db.select({ n: sql<number>`count(*)` }).from(notifications);
    // The daily dedupe means the forced run queues nothing new for reminders.
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    expect(await notes(due3, "due_soon")).toHaveLength(1);
    expect(await db.select().from(cronRuns).where(eq(cronRuns.job, "daily"))).toHaveLength(1);
  });

  it("the next day sends the overdue reminder again", async () => {
    // Day one: overdue_tick notified both parties and the reminder step was deduped against
    // the borrower's row. Day two adds exactly one more for the borrower.
    const borrowerRows = async () =>
      (await notes(pastDue, "overdue")).filter((n) => n.memberId === borrower);
    expect(await borrowerRows()).toHaveLength(1);
    const tomorrow = new Date(NOW.getTime() + D);
    const out = await runCronJob(db, "daily", dailySteps(db, config, notify, tomorrow), {
      now: tomorrow,
    });
    expect(out.status).toBe("completed");
    expect(await borrowerRows()).toHaveLength(2);
  });

  it("a failing step is recorded and the run continues", async () => {
    const day3 = new Date(NOW.getTime() + 2 * D);
    const steps = dailySteps(db, config, notify, day3);
    steps.splice(1, 0, {
      name: "boom",
      run: async () => {
        throw new Error("provider down");
      },
    });
    const errors: string[] = [];
    const out = await runCronJob(db, "daily", steps, { now: day3, onError: (s) => errors.push(s) });
    expect(out.status).toBe("completed_with_errors");
    expect(errors).toEqual(["boom"]);
    expect(out.steps.find((s) => s.step === "boom")).toMatchObject({
      ok: false,
      error: "provider down",
    });
    expect(out.steps.filter((s) => s.ok).length).toBe(steps.length - 1);
  });
});

describe("monthly job", () => {
  it("runs the pool for the previous month and the payout batch, idempotently", async () => {
    const out = await runCronJob(db, "monthly", monthlySteps(db, config, NOW), { now: NOW });
    expect(out.status, JSON.stringify(out.steps)).toBe("completed");
    const runs = await db.select().from(poolRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].month).toEqual(new Date("2026-08-01"));
    const again = await runCronJob(db, "monthly", monthlySteps(db, config, NOW), {
      now: NOW,
      force: true,
    });
    expect(again.status).toBe("completed");
    expect(await db.select().from(poolRuns)).toHaveLength(1);
    expect(await db.select().from(payouts)).toHaveLength(0); // nobody has a verified UPI here
  });
});
