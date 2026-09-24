import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  books,
  clusters,
  copies,
  ledgerEntries,
  members,
  plans,
  subscriptionPayments,
  webhookEvents,
} from "@/db/schema";
import { CONFIG_DEFAULTS } from "@/lib/config/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { processRazorpayWebhook, webhookEventId, type RazorpayWebhook } from "./webhooks";

let db: TestDb;
let close: () => Promise<void>;
let clusterId: string;
let memberId: string;
const NOW = new Date("2026-09-21T10:00:00Z");
const config = CONFIG_DEFAULTS;

const sub = (
  over: Partial<{
    id: string;
    plan_id: string;
    status: string;
    notes: Record<string, string>;
  }> = {},
) => ({
  entity: {
    id: "sub_1",
    plan_id: "plan_regular",
    customer_id: "cust_1",
    status: "active",
    notes: { member_id: memberId },
    ...over,
  },
});
const payment = (
  over: Partial<{
    id: string;
    amount: number;
    status: string;
    notes: Record<string, string>;
    created_at: number;
  }> = {},
) => ({
  entity: {
    id: "pay_1",
    amount: 24900,
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
  await db.insert(plans).values({
    code: "regular",
    name: "Regular",
    pricePaise: 24900,
    concurrentLimit: 2,
    loanPeriodDays: 21,
    razorpayPlanId: "plan_regular",
  });
  const [book] = await db
    .insert(books)
    .values({
      isbn13: "9780062316097",
      title: "Sapiens",
      authors: ["Harari"],
      source: "google_books",
    })
    .returning();
  [{ id: memberId }] = await db
    .insert(members)
    .values({
      authUserId: crypto.randomUUID(),
      phoneHash: "m",
      displayName: "M",
      clusterId,
      state: "registered",
    })
    .returning({ id: members.id });
  // Borrow gate satisfied: 3 listed, one verified.
  for (let i = 0; i < 3; i++) {
    await db.insert(copies).values({
      bookId: book.id,
      ownerId: memberId,
      clusterId,
      condition: "good",
      replacementValuePaise: 30000,
      listingPhotoPath: `p${i}.jpg`,
      allowedHandoffs: ["meetup"],
      verificationStatus: i === 0 ? "verified" : "unverified",
    });
  }
});
afterAll(() => close());

describe("webhookEventId", () => {
  it("prefers the header and falls back to a body hash", () => {
    expect(webhookEventId("evt_123", "{}")).toBe("evt_123");
    expect(webhookEventId(null, '{"a":1}')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(webhookEventId(null, '{"a":1}')).toBe(webhookEventId("  ", '{"a":1}'));
  });
});

describe("activation flow via webhooks", () => {
  it("subscription.activated attaches the plan but does not activate without a deposit", async () => {
    const out = await run(
      "evt_sub_act",
      envelope("subscription.activated", { subscription: sub() }),
    );
    expect(out).toEqual({ status: "processed", event: "subscription.activated", memberId });
    const m = await member();
    expect(m.planId).not.toBeNull();
    expect(m.razorpaySubscriptionId).toBe("sub_1");
    expect(m.razorpayCustomerId).toBe("cust_1");
    expect(m.state).toBe("registered");
  });

  it("payment.captured for the deposit posts deposit_in and activates the member", async () => {
    const out = await run(
      "evt_dep",
      envelope("payment.captured", {
        payment: payment({
          id: "pay_dep",
          amount: 75000,
          notes: { member_id: memberId, purpose: "deposit" },
        }),
      }),
    );
    expect(out.status).toBe("processed");
    const m = await member();
    expect(m.depositBalancePaise).toBe(75000);
    expect(m.state).toBe("active");
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.memberId, memberId));
    expect(entries).toEqual([
      expect.objectContaining({ kind: "deposit_in", amountPaise: 75000, razorpayRef: "pay_dep" }),
    ]);
  });

  it("the same webhook delivered twice is a no-op", async () => {
    const out = await run(
      "evt_dep",
      envelope("payment.captured", {
        payment: payment({
          id: "pay_dep",
          amount: 75000,
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

  it("subscription.charged records revenue with the pool month", async () => {
    const out = await run(
      "evt_charge",
      envelope("subscription.charged", {
        subscription: sub(),
        payment: payment({ id: "pay_month", amount: 24900 }),
      }),
    );
    expect(out.status).toBe("processed");
    const [p] = await db
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.razorpayPaymentId, "pay_month"));
    expect(p.status).toBe("captured");
    expect(p.poolMonth).toEqual(new Date("2026-09-01"));
    // A second charged event for the same payment (different event id) is absorbed by the payment id unique.
    await run(
      "evt_charge_dupe",
      envelope("subscription.charged", {
        subscription: sub(),
        payment: payment({ id: "pay_month", amount: 24900 }),
      }),
    );
    expect(
      await db
        .select()
        .from(subscriptionPayments)
        .where(eq(subscriptionPayments.razorpayPaymentId, "pay_month")),
    ).toHaveLength(1);
  });

  it("pending starts the clock; halted lapses; a later charge brings the member back", async () => {
    await run(
      "evt_pending",
      envelope("subscription.pending", {
        subscription: sub({ status: "pending" }),
        payment: payment({ id: "pay_fail", status: "failed" }),
      }),
    );
    expect((await member()).subscriptionPendingSince).toEqual(NOW);
    const [failed] = await db
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.razorpayPaymentId, "pay_fail"));
    expect(failed.status).toBe("failed");

    await run(
      "evt_halted",
      envelope("subscription.halted", { subscription: sub({ status: "halted" }) }),
    );
    expect((await member()).state).toBe("lapsed");

    await run(
      "evt_charge2",
      envelope("subscription.charged", {
        subscription: sub(),
        payment: payment({ id: "pay_month2", amount: 24900 }),
      }),
    );
    const m = await member();
    expect(m.state).toBe("active");
    expect(m.subscriptionPendingSince).toBeNull();
  });

  it("cancelled clears the plan; refund.processed posts deposit_refund", async () => {
    await run(
      "evt_cancel",
      envelope("subscription.cancelled", { subscription: sub({ status: "cancelled" }) }),
    );
    let m = await member();
    expect(m.state).toBe("cancelled");
    expect(m.planId).toBeNull();

    await run(
      "evt_refund",
      envelope("refund.processed", {
        refund: {
          entity: {
            id: "rfnd_1",
            payment_id: "pay_dep",
            amount: 75000,
            status: "processed",
            notes: { member_id: memberId, purpose: "deposit_refund" },
          },
        },
      }),
    );
    m = await member();
    expect(m.depositBalancePaise).toBe(0);
  });

  it("ignores payments that are not deposits, and unknown events", async () => {
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

  it("records a processing error on the webhook row and rethrows", async () => {
    const bad = envelope("subscription.activated", {
      subscription: sub({ id: "sub_bad", plan_id: "plan_missing" }),
    });
    await expect(run("evt_bad", bad)).rejects.toThrow(/No plan/);
    const [row] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, "evt_bad"));
    expect(row.error).toMatch(/No plan/);
    expect(row.processedAt).not.toBeNull();
  });
});
