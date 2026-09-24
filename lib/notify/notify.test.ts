import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { books, clusters, copies, loans, members, notifications } from "@/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {
  mockProviders,
  type SendResult,
  type SmsProvider,
  type WhatsAppProvider,
} from "./providers";
import {
  alreadySentToday,
  dispatchQueued,
  enqueue,
  recordDeliveryStatus,
  sweepUndelivered,
  type NotifyDeps,
} from "./send";
import { isDailyReminder, renderSms, TEMPLATE_NAMES, whatsappParams } from "./templates";

const NOW = new Date("2026-09-21T10:00:00Z");
const MIN = 60_000;

describe("templates", () => {
  it("every SMS variant renders under 160 characters with typical vars", () => {
    const vars = {
      book: "Sapiens: A Brief History of Humankind",
      borrower: "Ananya",
      lender: "Rohan",
      other: "Rohan",
      trust: 62,
      onTime: 4,
      handoff: "meet-up",
      dueAt: NOW.toISOString(),
      amountPaise: 49900,
      chargePaise: 15000,
      resolution: "partial_charge",
      month: "2026-08-01",
      loans: 3,
      creditPaise: 12345,
      upiId: "ananya@okaxis",
      cluster: "Jayanagar",
      venue: "Third Wave 12th Main",
      link: "https://bookerreads.in/loans/abc",
    };
    for (const name of TEMPLATE_NAMES) {
      const sms = renderSms(name, vars);
      expect(sms.length, `${name}: ${sms}`).toBeLessThanOrEqual(160);
      expect(whatsappParams(name, vars).every((p) => typeof p === "string")).toBe(true);
    }
  });

  it("flags only reminder templates as daily", () => {
    expect(isDailyReminder("overdue")).toBe(true);
    expect(isDailyReminder("due_soon")).toBe(true);
    expect(isDailyReminder("request_received")).toBe(false);
  });

  it("formats money and dates in SMS", () => {
    expect(renderSms("book_lost", { book: "X", amountPaise: 49900 })).toContain("₹499");
    expect(renderSms("on_loan", { book: "X", dueAt: "2026-10-12T00:00:00Z" })).toMatch(/12 Oct/);
  });
});

describe("dispatch (db)", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let lender: string;
  let borrower: string;
  let loanId: string;
  const waSent: Array<{ template: string; params: string[] }> = [];
  const smsSent: string[] = [];
  let waResult: SendResult = { ok: true, providerRef: "wa-1" };

  const whatsapp: WhatsAppProvider = {
    async sendTemplate({ template, bodyParams }) {
      waSent.push({ template, params: bodyParams });
      return waResult;
    },
  };
  const sms: SmsProvider = {
    async sendText({ text }) {
      smsSent.push(text);
      return { ok: true, providerRef: `sms-${smsSent.length}` };
    },
  };
  const deps = (now: Date): NotifyDeps => ({
    whatsapp,
    sms,
    phoneFor: async (id) => (id === "nobody" ? null : "919999900001"),
    appUrl: "https://app.test",
    now: () => now,
  });

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    const [c] = await db
      .insert(clusters)
      .values({ slug: "ce", name: "CE", pincodes: [], status: "open" })
      .returning();
    const ms = await db
      .insert(members)
      .values([
        {
          authUserId: crypto.randomUUID(),
          phoneHash: "l",
          displayName: "Rohan",
          clusterId: c.id,
          trustScore: 70,
        },
        {
          authUserId: crypto.randomUUID(),
          phoneHash: "b",
          displayName: "Ananya",
          clusterId: c.id,
          trustScore: 62,
        },
      ])
      .returning({ id: members.id });
    [lender, borrower] = ms.map((m) => m.id);
    const [book] = await db
      .insert(books)
      .values({
        isbn13: "9780062316097",
        title: "Sapiens",
        authors: ["Harari"],
        source: "google_books",
      })
      .returning();
    const [copy] = await db
      .insert(copies)
      .values({
        bookId: book.id,
        ownerId: lender,
        clusterId: c.id,
        condition: "good",
        replacementValuePaise: 49900,
        listingPhotoPath: "p",
        allowedHandoffs: ["meetup"],
      })
      .returning();
    [{ id: loanId }] = await db
      .insert(loans)
      .values({
        copyId: copy.id,
        bookId: book.id,
        lenderId: lender,
        borrowerId: borrower,
        state: "on_loan",
        handoffMethod: "meetup",
        dueAt: new Date("2026-10-01"),
      })
      .returning({ id: loans.id });
  });
  afterAll(() => close());

  it("sends a queued WhatsApp row with enriched vars and marks it sent", async () => {
    const id = await enqueue(db, {
      memberId: lender,
      template: "request_received",
      vars: { handoff: "meet-up" },
      loanId,
      now: NOW,
    });
    expect(id).not.toBeNull();
    const out = await dispatchQueued(db, deps(NOW));
    expect(out).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(waSent.at(-1)).toEqual({
      template: "request_received",
      params: ["Ananya", "Sapiens", "62", "0", "meet-up", `https://app.test/loans/${loanId}`],
    });
    const [row] = await db.select().from(notifications).where(eq(notifications.id, id!));
    expect(row.status).toBe("sent");
    expect(row.providerRef).toBe("wa-1");
  });

  it("delivery webhook flips sent to delivered", async () => {
    expect(
      await recordDeliveryStatus(db, { providerRef: "wa-1", status: "delivered", at: NOW }),
    ).toBe(true);
    expect(await recordDeliveryStatus(db, { providerRef: "nope", status: "delivered" })).toBe(
      false,
    );
  });

  it("dedupes daily reminders per loan per day, allows tomorrow's", async () => {
    const a = await enqueue(db, {
      memberId: borrower,
      template: "overdue",
      vars: {},
      loanId,
      now: NOW,
    });
    const b = await enqueue(db, {
      memberId: borrower,
      template: "overdue",
      vars: {},
      loanId,
      now: new Date(NOW.getTime() + 5 * 3600_000),
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(await alreadySentToday(db, borrower, "overdue", loanId, NOW)).toBe(true);
    const tomorrow = new Date("2026-09-22T01:00:00Z");
    expect(await alreadySentToday(db, borrower, "overdue", loanId, tomorrow)).toBe(false);
    // Non-reminder templates are never deduped.
    expect(
      await enqueue(db, { memberId: borrower, template: "returned", vars: {}, loanId, now: NOW }),
    ).not.toBeNull();
    expect(
      await enqueue(db, { memberId: borrower, template: "returned", vars: {}, loanId, now: NOW }),
    ).not.toBeNull();
    await dispatchQueued(db, deps(NOW));
  });

  it("falls back to SMS immediately when WhatsApp rejects", async () => {
    waResult = { ok: false, error: "template not approved", retryable: false };
    const id = await enqueue(db, {
      memberId: lender,
      template: "request_declined",
      vars: {},
      loanId,
      now: NOW,
    });
    const first = await dispatchQueued(db, deps(NOW));
    expect(first.failed).toBe(1);
    const fallback = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.channel, "sms"), eq(notifications.template, "request_declined")));
    expect(fallback).toHaveLength(1);
    expect(fallback[0].status).toBe("queued");
    const second = await dispatchQueued(db, deps(NOW));
    expect(second.sent).toBe(1);
    expect(smsSent.at(-1)).toContain("Sapiens");
    const [wa] = await db.select().from(notifications).where(eq(notifications.id, id!));
    expect(wa.status).toBe("failed");
    waResult = { ok: true, providerRef: "wa-2" };
  });

  it("sweeps WhatsApp rows undelivered after 10 minutes into one SMS each", async () => {
    waResult = { ok: true, providerRef: "wa-stale" };
    await enqueue(db, { memberId: borrower, template: "on_loan", vars: {}, loanId, now: NOW });
    await dispatchQueued(db, deps(NOW));
    const fallbacksFor = async () =>
      db
        .select()
        .from(notifications)
        .where(and(eq(notifications.channel, "sms"), eq(notifications.template, "on_loan")));
    // Under 10 minutes: nothing for this row.
    await sweepUndelivered(db, deps(new Date(NOW.getTime() + 9 * MIN)));
    expect(await fallbacksFor()).toHaveLength(0);
    // Over 10 minutes: exactly one SMS fallback, sent.
    await sweepUndelivered(db, deps(new Date(NOW.getTime() + 11 * MIN)));
    const once = await fallbacksFor();
    expect(once).toHaveLength(1);
    expect(once[0].status).toBe("sent");
    // A later sweep does not create a second fallback for the same row.
    await sweepUndelivered(db, deps(new Date(NOW.getTime() + 12 * MIN)));
    expect(await fallbacksFor()).toHaveLength(1);
  });

  it("skips members without a phone and records why", async () => {
    await db.insert(notifications).values({
      memberId: lender,
      template: "returned",
      channel: "whatsapp",
      payload: {},
      status: "queued",
      createdAt: NOW,
    });
    const d = deps(NOW);
    d.phoneFor = async () => null;
    const out = await dispatchQueued(db, d);
    expect(out.skipped).toBe(1);
  });

  it("mock providers report success and log", async () => {
    const lines: string[] = [];
    const mock = mockProviders((l) => lines.push(l));
    const r = await mock.whatsapp.sendTemplate({ phone: "91x", template: "t", bodyParams: ["a"] });
    expect(r.ok).toBe(true);
    expect(lines[0]).toContain("[notify:mock:whatsapp]");
  });
});
