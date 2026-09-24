import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import {
  checkAndRecordOtpAttempt,
  clientIpFromHeaders,
  decideOtpLimit,
  pruneOtpAttempts,
} from "./otp-rate-limit";

const T0 = new Date("2026-09-21T10:00:00Z");
const min = (n: number) => new Date(T0.getTime() - n * 60_000);

describe("decideOtpLimit", () => {
  it("allows the first three sends for a phone within ten minutes", () => {
    expect(decideOtpLimit(T0, [], [])).toEqual({ allowed: true });
    expect(decideOtpLimit(T0, [min(1), min(2)], [min(1), min(2)])).toEqual({ allowed: true });
  });

  it("blocks the fourth send for a phone and says when to retry", () => {
    const d = decideOtpLimit(T0, [min(1), min(4), min(9)], []);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("phone");
      // oldest of the three was 9 min ago; window is 10 min -> retry in 1 min
      expect(d.retryAfterMs).toBe(60_000);
    }
  });

  it("ignores phone attempts older than ten minutes", () => {
    expect(decideOtpLimit(T0, [min(11), min(12), min(13)], [])).toEqual({ allowed: true });
  });

  it("blocks the eleventh send from an IP within an hour", () => {
    const ip = Array.from({ length: 10 }, (_, i) => min(i * 5 + 1));
    const d = decideOtpLimit(T0, [], ip);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("ip");
    expect(decideOtpLimit(T0, [], ip.slice(0, 9))).toEqual({ allowed: true });
  });

  it("phone limit is checked before ip limit", () => {
    const d = decideOtpLimit(
      T0,
      [min(1), min(2), min(3)],
      Array.from({ length: 12 }, (_, i) => min(i)),
    );
    if (!d.allowed) expect(d.reason).toBe("phone");
  });
});

describe("clientIpFromHeaders", () => {
  it("takes the first hop of x-forwarded-for", () => {
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe(
      "1.2.3.4",
    );
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });
});

describe("checkAndRecordOtpAttempt (db)", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("records allowed attempts and refuses the fourth for the same phone", async () => {
    const input = { phoneHash: "ph1", ipHash: "ip1" };
    for (let i = 0; i < 3; i++) {
      const d = await checkAndRecordOtpAttempt(db, { ...input, now: min(3 - i) });
      expect(d.allowed).toBe(true);
    }
    const fourth = await checkAndRecordOtpAttempt(db, { ...input, now: T0 });
    expect(fourth.allowed).toBe(false);
    // A different phone from the same IP is still fine (4 of 10 for the IP).
    expect(
      (await checkAndRecordOtpAttempt(db, { phoneHash: "ph2", ipHash: "ip1", now: T0 })).allowed,
    ).toBe(true);
  });

  it("refused attempts are not recorded", async () => {
    const input = { phoneHash: "ph3", ipHash: "ip3" };
    for (let i = 0; i < 3; i++) await checkAndRecordOtpAttempt(db, { ...input, now: T0 });
    await checkAndRecordOtpAttempt(db, { ...input, now: T0 });
    await checkAndRecordOtpAttempt(db, { ...input, now: T0 });
    // Ten minutes later only the 3 recorded ones have aged out, so a send is allowed.
    const later = new Date(T0.getTime() + 10 * 60_000 + 1);
    expect((await checkAndRecordOtpAttempt(db, { ...input, now: later })).allowed).toBe(true);
  });

  it("prunes old rows", async () => {
    const pruned = await pruneOtpAttempts(db, new Date(T0.getTime() + 3 * 60 * 60_000));
    expect(pruned).toBeGreaterThan(0);
  });
});
