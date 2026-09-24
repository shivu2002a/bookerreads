import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clusters, members, trustEvents } from "@/db/schema";
import { CONFIG_DEFAULTS } from "@/lib/config/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { acceptanceRate } from "./acceptance";
import { computeTrustScore, deltaFor, recomputeTrustScore, recordTrustEvent } from "./record";

const NOW = new Date("2026-09-21T10:00:00Z");
const monthsAgo = (n: number) => new Date(NOW.getTime() - n * 30 * 86_400_000);

describe("computeTrustScore", () => {
  it("starts at 50 with no events and no age", () => {
    expect(
      computeTrustScore({ deltaSum: 0, memberCreatedAt: NOW, now: NOW, ageBonusCapMonths: 6 }),
    ).toBe(50);
  });

  it("adds one point per month of age, capped", () => {
    expect(
      computeTrustScore({
        deltaSum: 0,
        memberCreatedAt: monthsAgo(3),
        now: NOW,
        ageBonusCapMonths: 6,
      }),
    ).toBe(53);
    expect(
      computeTrustScore({
        deltaSum: 0,
        memberCreatedAt: monthsAgo(24),
        now: NOW,
        ageBonusCapMonths: 6,
      }),
    ).toBe(56);
    expect(
      computeTrustScore({
        deltaSum: 0,
        memberCreatedAt: monthsAgo(24),
        now: NOW,
        ageBonusCapMonths: 0,
      }),
    ).toBe(50);
  });

  it("clamps to 0 and 100", () => {
    expect(
      computeTrustScore({ deltaSum: -200, memberCreatedAt: NOW, now: NOW, ageBonusCapMonths: 6 }),
    ).toBe(0);
    expect(
      computeTrustScore({ deltaSum: 200, memberCreatedAt: NOW, now: NOW, ageBonusCapMonths: 6 }),
    ).toBe(100);
  });

  it("reads deltas from config, not constants", () => {
    const weights = { ...CONFIG_DEFAULTS.trust_weights, book_lost: -40 };
    expect(deltaFor("book_lost", weights)).toBe(-40);
    expect(deltaFor("return_on_time", CONFIG_DEFAULTS.trust_weights)).toBe(2);
  });
});

describe("acceptanceRate", () => {
  it("is null under three answered requests", () => {
    expect(acceptanceRate([])).toEqual({ rate: null, answered: 0 });
    expect(acceptanceRate(["accepted", "declined"])).toEqual({ rate: null, answered: 2 });
  });

  it("counts every non-declined, non-expired state as accepted", () => {
    expect(acceptanceRate(["returned", "declined", "expired", "on_loan"])).toEqual({
      rate: 0.5,
      answered: 4,
    });
  });

  it("only looks at the last 20", () => {
    const states = [...Array(20).fill("accepted"), ...Array(30).fill("declined")] as Parameters<
      typeof acceptanceRate
    >[0];
    expect(acceptanceRate(states).rate).toBe(1);
  });
});

describe("recordTrustEvent (db)", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let memberId: string;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    const [c] = await db
      .insert(clusters)
      .values({ slug: "ce", name: "CE", pincodes: [], status: "open" })
      .returning();
    [{ id: memberId }] = await db
      .insert(members)
      .values({
        authUserId: crypto.randomUUID(),
        phoneHash: "t",
        displayName: "T",
        clusterId: c.id,
        createdAt: monthsAgo(2),
      })
      .returning({ id: members.id });
  });
  afterAll(() => close());

  it("inserts the event with the config delta and recomputes the cached score", async () => {
    const r1 = await recordTrustEvent(
      db,
      { memberId, kind: "return_on_time", loanId: null, now: NOW },
      CONFIG_DEFAULTS,
    );
    expect(r1.delta).toBe(2);
    expect(r1.score).toBe(50 + 2 + 2); // two months of age
    const r2 = await recordTrustEvent(
      db,
      { memberId, kind: "book_lost", loanId: null, now: NOW },
      CONFIG_DEFAULTS,
    );
    expect(r2.score).toBe(50 + 2 - 25 + 2);
    const [m] = await db
      .select({ score: members.trustScore })
      .from(members)
      .where(eq(members.id, memberId));
    expect(m.score).toBe(29);
    expect(
      await db.select().from(trustEvents).where(eq(trustEvents.memberId, memberId)),
    ).toHaveLength(2);
  });

  it("recompute with changed weights re-reads stored deltas, not the new weights", async () => {
    // Stored deltas are what was applied at the time; a weight change affects future events only.
    const changed = {
      ...CONFIG_DEFAULTS,
      trust_weights: { ...CONFIG_DEFAULTS.trust_weights, book_lost: -5 },
    };
    expect(await recomputeTrustScore(db, memberId, changed, NOW)).toBe(29);
  });
});
