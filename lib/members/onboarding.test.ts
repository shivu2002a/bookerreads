import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clusters, members } from "@/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { ensureMemberForAuthUser } from "./ensure";
import {
  completeOnboarding,
  displayNameSchema,
  findClusterByPincode,
  isOnWaitlist,
  joinWaitlist,
  listClustersForOnboarding,
  pincodeSchema,
} from "./onboarding";

let db: TestDb;
let close: () => Promise<void>;
let open: { id: string };
let closed: { id: string };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [open, closed] = await db
    .insert(clusters)
    .values([
      { slug: "central-east", name: "Central-East", pincodes: ["560038"], status: "open" },
      { slug: "south", name: "South", pincodes: ["560041", "560078"], status: "waitlist" },
    ])
    .returning({ id: clusters.id });
});
afterAll(() => close());

async function newMember(phone: string) {
  return (await ensureMemberForAuthUser(db, { authUserId: crypto.randomUUID(), phone })).member;
}

describe("validation", () => {
  it("accepts ordinary names and rejects reserved or odd ones", () => {
    expect(displayNameSchema.safeParse("Ananya R.").success).toBe(true);
    expect(displayNameSchema.safeParse("A").success).toBe(false);
    expect(displayNameSchema.safeParse("Admin Ananya").success).toBe(false);
    expect(displayNameSchema.safeParse("x".repeat(31)).success).toBe(false);
    expect(displayNameSchema.safeParse("<script>").success).toBe(false);
  });

  it("accepts Bangalore pincodes only", () => {
    expect(pincodeSchema.safeParse("560038").success).toBe(true);
    expect(pincodeSchema.safeParse("400001").success).toBe(false);
    expect(pincodeSchema.safeParse("56003").success).toBe(false);
  });
});

describe("clusters", () => {
  it("lists open and waitlist clusters separately", async () => {
    const list = await listClustersForOnboarding(db);
    expect(list.open.map((c) => c.slug)).toEqual(["central-east"]);
    expect(list.waitlist.map((c) => c.slug)).toEqual(["south"]);
  });

  it("finds a cluster by pincode", async () => {
    expect((await findClusterByPincode(db, "560078"))?.slug).toBe("south");
    expect(await findClusterByPincode(db, "560001")).toBeNull();
  });
});

describe("completeOnboarding", () => {
  it("sets name and cluster for an open cluster", async () => {
    const m = await newMember("919845000101");
    const res = await completeOnboarding(db, {
      memberId: m.id,
      displayName: "Ananya",
      clusterId: open.id,
    });
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(members).where(eq(members.id, m.id));
    expect(row.displayName).toBe("Ananya");
    expect(row.clusterId).toBe(open.id);
    expect(row.termsAcceptedAt).not.toBeNull();
  });

  it("refuses a waitlist cluster", async () => {
    const m = await newMember("919845000102");
    const res = await completeOnboarding(db, {
      memberId: m.id,
      displayName: "Rohan",
      clusterId: closed.id,
    });
    expect(res).toEqual({ ok: false, error: "cluster_not_open" });
  });
});

describe("joinWaitlist", () => {
  it("adds the member to the waitlist for a closed cluster and saves the name", async () => {
    const m = await newMember("919845000103");
    const res = await joinWaitlist(db, { memberId: m.id, displayName: "Meera", pincode: "560041" });
    expect(res.ok).toBe(true);
    expect(await isOnWaitlist(db, m.id, closed.id)).toBe(true);
    const [row] = await db.select().from(members).where(eq(members.id, m.id));
    expect(row.displayName).toBe("Meera");
    expect(row.clusterId).toBeNull();
  });

  it("is idempotent", async () => {
    const m = await newMember("919845000104");
    await joinWaitlist(db, { memberId: m.id, displayName: "K", pincode: "560041" });
    await expect(
      joinWaitlist(db, { memberId: m.id, displayName: "K", pincode: "560041" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("reports unknown pincodes", async () => {
    const m = await newMember("919845000105");
    expect(await joinWaitlist(db, { memberId: m.id, displayName: "D", pincode: "560001" })).toEqual(
      {
        ok: false,
        error: "no_cluster_for_pincode",
      },
    );
  });
});
