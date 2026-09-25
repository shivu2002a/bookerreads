import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  books,
  clusters,
  copies,
  ledgerEntries,
  loanPayments,
  loans,
  members,
  webhookEvents,
} from "@/db/schema";
import { CONFIG_DEFAULTS } from "@/lib/config/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { createRentalOrder, processPendingRefunds } from "./rental";
import { processRazorpayWebhook, webhookEventId, type RazorpayWebhook } from "./webhooks";

let db: TestDb;
let close: () => Promise<void>;
let clusterId: string;
let memberId: string;
let lenderId: string;
let copyId: string;
let bookId: string;

const NOW = new Date("2026-09-21T10:00:00Z");
const config = CONFIG_DEFAULTS;

const payment = (
  over: Partial<{
    id: string;
    amount: number;
    status: string;
    order_id: string | null;
    notes: Record<string, string>;
    created_at: number;
  }> = {},
) => ({
  entity: {
    id: "pay_1",
    amount: 50000,
    status: "captured",
    created_at: Math.floor(NOW.getTime() / 1000),
    ...over,
  },
});
const envelope = (event: string, payload: RazorpayWebhook["payload"]): RazorpayWebhook => ({
  event,
  created_at: Math.floor(NOW.getTime() / 1000),
  payload,
});
const run = (eventId: string, body: RazorpayWebhook) =>
  processRazorpayWebhook(db, { eventId, body, rawBody: JSON.stringify(body) }, config, NOW);
const member = async () => (await db.select().from(members).where(eq(members.id, memberId)))[0];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [{ id: clusterId }] = await db
    .insert(clusters)
    .values({ slug: "ce", name: "CE", pincodes: [], status: "open" })
    .returning({ id: clusters.id });
  const [book] = await db
    .insert(books)
    .values({
      isbn13: "9780062316097",
      title: "Sapiens",
      authors: ["Harari"],
      source: "google_books",
    })
    .returning();
  bookId = book.id;
  const [m, l] = await db
    .insert(members)
    .values([
      { authUserId: crypto.randomUUID(), phoneHash: "m", displayName: "M", clusterId },
      {
        authUserId: crypto.randomUUID(),
        phoneHash: "l",
        displayName: "L",
        clusterId,
        state: "active",
      },
    ])
    .returning({ id: members.id });
  memberId = m.id;
  lenderId = l.id;
  // Borrow gate: the member has one listed copy.
  await db.insert(copies).values({
    bookId,
    ownerId: memberId,
    clusterId,
    condition: "good",
    replacementValuePaise: 30000,
    listingPhotoPath: "p0.jpg",
    allowedHandoffs: ["meetup"],
  });
  // The lender's priced copy, which the member will borrow.
  [{ id: copyId }] = await db
    .insert(copies)
    .values({
      bookId,
      ownerId: lenderId,
      clusterId,
      condition: "good",
      replacementValuePaise: 30000,
      rentalPricePaise: 5000,
      loanPeriodDays: 21,
      listingPhotoPath: "p1.jpg",
      allowedHandoffs: ["meetup"],
      availability: "requested",
    })
    .returning({ id: copies.id });
});
afterAll(() => close());

describe("webhookEventId", () => {
  it("prefers the header and falls back to a body hash", () => {
    expect(webhookEventId("evt_123", "{}")).toBe("evt_123");
    expect(webhookEventId(null, '{"a":1}')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(webhookEventId(null, '{"a":1}')).toBe(webhookEventId("  ", '{"a":1}'));
  });
});

describe("deposit activation via webhooks", () => {
  it("payment.captured for the deposit posts deposit_in and activates the member", async () => {
    const out = await run(
      "evt_dep",
      envelope("payment.captured", {
        payment: payment({
          id: "pay_dep",
          amount: 50000,
          notes: { member_id: memberId, purpose: "deposit" },
        }),
      }),
    );
    expect(out).toEqual({ status: "processed", event: "payment.captured", memberId });
    const m = await member();
    expect(m.depositBalancePaise).toBe(50000);
    expect(m.state).toBe("active");
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.memberId, memberId));
    expect(entries).toEqual([
      expect.objectContaining({ kind: "deposit_in", amountPaise: 50000, razorpayRef: "pay_dep" }),
    ]);
  });

  it("the same webhook delivered twice is a no-op", async () => {
    const out = await run(
      "evt_dep",
      envelope("payment.captured", {
        payment: payment({
          id: "pay_dep",
          amount: 50000,
          notes: { member_id: memberId, purpose: "deposit" },
        }),
      }),
    );
    expect(out).toEqual({ status: "duplicate", event: "payment.captured" });
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.memberId, memberId));
    expect(entries).toHaveLength(1);
    const rows = await db.select().from(webhookEvents);
    expect(rows.filter((r) => r.providerEventId === "evt_dep")).toHaveLength(1);
  });

  it("refund.processed for a deposit posts deposit_refund", async () => {
    await run(
      "evt_refund",
      envelope("refund.processed", {
        refund: {
          entity: {
            id: "rfnd_1",
            payment_id: "pay_dep",
            amount: 50000,
            status: "processed",
            notes: { member_id: memberId, purpose: "deposit_refund" },
          },
        },
      }),
    );
    expect((await member()).depositBalancePaise).toBe(0);
  });
});

describe("rental payments", () => {
  let loanId: string;
  let orderId: string;

  beforeAll(async () => {
    // An accepted, unpaid loan for the lender's ₹50 copy (as the machine would have left it).
    [{ id: loanId }] = await db
      .insert(loans)
      .values({
        copyId,
        bookId,
        lenderId,
        borrowerId: memberId,
        state: "accepted",
        handoffMethod: "meetup",
        requestedAt: new Date(NOW.getTime() - 3_600_000),
        respondedAt: NOW,
        rentalPaise: 5000,
        platformFeePaise: 750,
        paymentDueAt: new Date(NOW.getTime() + 24 * 3_600_000),
      })
      .returning({ id: loans.id });
  });

  it("createRentalOrder raises one Razorpay order per loan and reuses it", async () => {
    const calls: unknown[] = [];
    const rz = {
      createOrder: async (input: unknown) => {
        calls.push(input);
        return { id: `order_${calls.length}`, amount: 5000, currency: "INR", status: "created" };
      },
    };
    const first = await createRentalOrder(db, rz, { loanId, memberId }, NOW);
    expect(first.ok && first.order).toMatchObject({ amountPaise: 5000, orderId: "order_1" });
    const again = await createRentalOrder(db, rz, { loanId, memberId }, NOW);
    expect(again.ok && again.order.orderId).toBe("order_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "rental", loanId, memberId });
    orderId = "order_1";

    expect(await createRentalOrder(db, rz, { loanId, memberId: lenderId }, NOW)).toEqual({
      ok: false,
      error: "not_borrower",
    });
  });

  it("payment.captured for a rental applies `pay` once; the duplicate is absorbed", async () => {
    const body = envelope("payment.captured", {
      payment: payment({
        id: "pay_rent",
        amount: 5000,
        order_id: orderId,
        notes: { member_id: memberId, purpose: "rental" },
      }),
    });
    const out = await run("evt_rent", body);
    expect(out).toEqual({ status: "processed", event: "payment.captured", memberId });
    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
    expect(loan.paidAt).toEqual(NOW);
    const [lp] = await db.select().from(loanPayments).where(eq(loanPayments.loanId, loanId));
    expect(lp).toMatchObject({ status: "captured", razorpayPaymentId: "pay_rent" });

    // Same payment, new event id (Razorpay retries): already paid, no second effect.
    const retry = await run("evt_rent_retry", body);
    expect(retry.status).toBe("processed");
    expect(
      await createRentalOrder(
        db,
        { createOrder: async () => ({}) as never },
        { loanId, memberId },
        NOW,
      ),
    ).toEqual({
      ok: false,
      error: "already_paid",
    });
  });

  it("a wrong amount is refused", async () => {
    const [{ id: other }] = await db
      .insert(loans)
      .values({
        copyId,
        bookId,
        lenderId,
        borrowerId: memberId,
        state: "declined",
        handoffMethod: "meetup",
        rentalPaise: 5000,
        platformFeePaise: 750,
      })
      .returning({ id: loans.id });
    const out = await run(
      "evt_rent_wrong",
      envelope("payment.captured", {
        payment: payment({
          id: "pay_wrong",
          amount: 100,
          notes: { purpose: "rental", loan_id: other },
        }),
      }),
    );
    expect(out.status).toBe("ignored");
  });

  it("processPendingRefunds calls Razorpay for flagged rows and marks them refunded", async () => {
    await db
      .update(loanPayments)
      .set({ status: "refund_pending" })
      .where(eq(loanPayments.loanId, loanId));
    const refunds: unknown[] = [];
    const rz = {
      createRefund: async (input: unknown) => {
        refunds.push(input);
        return {
          id: "rfnd_rent",
          payment_id: "pay_rent",
          amount: 5000,
          status: "processed" as const,
        };
      },
    };
    const res = await processPendingRefunds(db, rz, NOW);
    expect(res).toEqual({ refunded: 1, failed: 0 });
    expect(refunds[0]).toMatchObject({
      paymentId: "pay_rent",
      amountPaise: 5000,
      purpose: "rental_refund",
    });
    const [lp] = await db.select().from(loanPayments).where(eq(loanPayments.loanId, loanId));
    expect(lp).toMatchObject({ status: "refunded", razorpayRefundId: "rfnd_rent" });
    // Nothing left to do on the next run.
    expect(await processPendingRefunds(db, rz, NOW)).toEqual({ refunded: 0, failed: 0 });
  });

  it("ignores payments that are not deposits or rentals, and unknown events", async () => {
    expect(
      (
        await run(
          "evt_other_pay",
          envelope("payment.captured", {
            payment: payment({ id: "pay_x", notes: { purpose: "merch" } }),
          }),
        )
      ).status,
    ).toBe("ignored");
    expect((await run("evt_unknown", envelope("order.paid", {}))).status).toBe("ignored");
  });
});
