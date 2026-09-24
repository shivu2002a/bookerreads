import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, members } from "@/db/schema";
import { hashPhone } from "@/lib/auth/phone-hash";
import { createTestDb, type TestDb } from "@/test/db";
import { ensureMemberForAuthUser } from "./ensure";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

describe("ensureMemberForAuthUser", () => {
  it("creates a registered member with trust 50 and a hashed phone", async () => {
    const authUserId = crypto.randomUUID();
    const { member, created } = await ensureMemberForAuthUser(db, {
      authUserId,
      phone: "919845012345",
    });
    expect(created).toBe(true);
    expect(member.state).toBe("registered");
    expect(member.trustScore).toBe(50);
    expect(member.displayName).toBeNull();
    expect(member.clusterId).toBeNull();
    expect(member.phoneHash).toBe(hashPhone("919845012345"));
    const evs = await db.select().from(events).where(eq(events.aggregateId, member.id));
    expect(evs.map((e) => e.type)).toEqual(["member.created"]);
  });

  it("returns the existing member on later logins without a new event", async () => {
    const authUserId = crypto.randomUUID();
    const first = await ensureMemberForAuthUser(db, { authUserId, phone: "919845000001" });
    const second = await ensureMemberForAuthUser(db, { authUserId, phone: "919845000001" });
    expect(second.created).toBe(false);
    expect(second.member.id).toBe(first.member.id);
    const evs = await db.select().from(events).where(eq(events.aggregateId, first.member.id));
    expect(evs).toHaveLength(1);
  });

  it("never stores the raw phone number anywhere in members", async () => {
    const authUserId = crypto.randomUUID();
    await ensureMemberForAuthUser(db, { authUserId, phone: "919845099999" });
    const [row] = await db.select().from(members).where(eq(members.authUserId, authUserId));
    expect(JSON.stringify(row)).not.toContain("9845099999");
  });
});
