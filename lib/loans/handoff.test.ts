import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropPoints, loans, members } from "@/db/schema";
import { seed } from "@/db/seed/run";
import { createTestDb, type TestDb } from "@/test/db";
import { loadDropPointPage } from "./drop-point-page";
import { generateHandoffCode } from "./persist";

describe("generateHandoffCode", () => {
  it("is 6 characters from an unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateHandoffCode();
      expect(c).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it("rarely repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateHandoffCode()));
    expect(seen.size).toBeGreaterThan(495);
  });
});

describe("drop-point QR landing", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seed(db, { now: new Date("2026-09-21T10:00:00Z") });
  }, 60_000);
  afterAll(() => close());

  it("rejects a wrong secret but still names the venue", async () => {
    const [dp] = await db.select().from(dropPoints).limit(1);
    const page = await loadDropPointPage(db, dp.id, "nope", null);
    expect(page?.verified).toBe(false);
    expect(page?.dropPoint.name).toBe(dp.name);
    expect(page?.actions).toEqual([]);
  });

  it("lists the lender's pending drop and, after the drop, the borrower's collect", async () => {
    // Seed has an accepted drop-point loan where the lender has already dropped (outLenderConfirmedAt set).
    const [l] = await db
      .select()
      .from(loans)
      .where(eq(loans.state, "accepted"))
      .then((rows) =>
        rows.filter((r) => r.handoffMethod === "drop_point" && r.outLenderConfirmedAt),
      );
    const [dp] = await db.select().from(dropPoints).where(eq(dropPoints.id, l.dropPointId!));
    const asLender = await loadDropPointPage(db, dp.id, dp.qrSecret, l.lenderId);
    expect(asLender!.verified).toBe(true);
    expect(asLender!.actions.find((a) => a.loanId === l.id)).toBeUndefined(); // lender already dropped
    const asBorrower = await loadDropPointPage(db, dp.id, dp.qrSecret, l.borrowerId);
    expect(asBorrower!.actions.find((a) => a.loanId === l.id)).toMatchObject({
      action: "collect",
      phase: "out",
    });
    const [outsider] = await db
      .select()
      .from(members)
      .where(eq(members.state, "registered"))
      .limit(1);
    const asOutsider = await loadDropPointPage(db, dp.id, dp.qrSecret, outsider.id);
    expect(asOutsider!.actions.find((a) => a.loanId === l.id)).toBeUndefined();
  });

  it("returns null for an unknown drop point", async () => {
    expect(await loadDropPointPage(db, crypto.randomUUID(), "x", null)).toBeNull();
  });
});
