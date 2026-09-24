import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loans, members } from "@/db/schema";
import { seed } from "@/db/seed/run";
import { createTestDb, type TestDb } from "@/test/db";
import {
  getLoanForViewer,
  isChatOpen,
  listIncoming,
  listOutgoing,
  sendLoanMessage,
} from "./queries";

let db: TestDb;
let close: () => Promise<void>;
const NOW = new Date("2026-09-21T10:00:00Z");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seed(db, { now: NOW });
}, 60_000);
afterAll(() => close());

describe("loan lists", () => {
  it("incoming puts open loans first and includes borrower trust and on-time returns", async () => {
    const [l] = await db.select().from(loans).where(eq(loans.state, "requested")).limit(1);
    const list = await listIncoming(db, l.lenderId);
    expect(list.length).toBeGreaterThan(0);
    const firstClosed = list.findIndex(
      (x) => !["requested", "accepted", "on_loan", "overdue"].includes(x.state),
    );
    if (firstClosed > 0)
      expect(
        list
          .slice(firstClosed)
          .every((x) => !["requested", "accepted", "on_loan", "overdue"].includes(x.state)),
      ).toBe(true);
    const item = list.find((x) => x.id === l.id)!;
    expect(item.borrower.displayName).toBeTruthy();
    expect(item.borrower.onTimeReturns).toBeGreaterThanOrEqual(0);
    expect(item.book.title).toBeTruthy();
  });

  it("outgoing lists the borrower's loans", async () => {
    const [l] = await db.select().from(loans).where(eq(loans.state, "on_loan")).limit(1);
    const list = await listOutgoing(db, l.borrowerId);
    expect(list.some((x) => x.id === l.id)).toBe(true);
    expect(list.every((x) => x.borrower.id === l.borrowerId)).toBe(true);
  });
});

describe("getLoanForViewer", () => {
  it("returns detail for a party and null for an outsider; admin sees everything", async () => {
    const [l] = await db.select().from(loans).where(eq(loans.state, "on_loan")).limit(1);
    const [admin] = await db.select().from(members).where(eq(members.isAdmin, true));
    const [outsider] = await db
      .select()
      .from(members)
      .where(sql`${members.id} not in (${l.lenderId}, ${l.borrowerId}) and not ${members.isAdmin}`)
      .limit(1);

    const asLender = await getLoanForViewer(db, l.id, { id: l.lenderId, isAdmin: false });
    expect(asLender?.viewerParty).toBe("lender");
    expect(asLender!.timeline.length).toBeGreaterThan(0);
    expect(asLender!.photos.length).toBeGreaterThan(0);
    expect(asLender!.messages.length).toBeGreaterThan(0);

    expect(
      (await getLoanForViewer(db, l.id, { id: l.borrowerId, isAdmin: false }))?.viewerParty,
    ).toBe("borrower");
    expect(await getLoanForViewer(db, l.id, { id: outsider.id, isAdmin: false })).toBeNull();
    expect(await getLoanForViewer(db, l.id, { id: admin.id, isAdmin: true })).not.toBeNull();
  });

  it("includes drop point and code for drop-point loans", async () => {
    const [l] = await db
      .select()
      .from(loans)
      .where(sql`${loans.handoffMethod} = 'drop_point' and ${loans.handoffCode} is not null`)
      .limit(1);
    const d = await getLoanForViewer(db, l.id, { id: l.lenderId, isAdmin: false });
    expect(d?.dropPoint?.name).toBeTruthy();
    expect(d?.handoffCode).toHaveLength(6);
  });
});

describe("chat", () => {
  it("is open during the loan and for 48 h after, closed otherwise", () => {
    expect(isChatOpen({ state: "accepted", returnedAt: null, respondedAt: NOW }, NOW)).toBe(true);
    expect(
      isChatOpen(
        {
          state: "returned",
          returnedAt: new Date(NOW.getTime() - 47 * 3_600_000),
          respondedAt: null,
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      isChatOpen(
        {
          state: "returned",
          returnedAt: new Date(NOW.getTime() - 49 * 3_600_000),
          respondedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
    expect(isChatOpen({ state: "requested", returnedAt: null, respondedAt: null }, NOW)).toBe(
      false,
    );
    expect(isChatOpen({ state: "declined", returnedAt: null, respondedAt: NOW }, NOW)).toBe(false);
  });

  it("only parties can send, and only while open", async () => {
    const [open] = await db.select().from(loans).where(eq(loans.state, "on_loan")).limit(1);
    const [outsider] = await db
      .select()
      .from(members)
      .where(sql`${members.id} not in (${open.lenderId}, ${open.borrowerId})`)
      .limit(1);
    expect(
      (await sendLoanMessage(db, { loanId: open.id, senderId: outsider.id, body: "hi" })).ok,
    ).toBe(false);
    expect(
      (await sendLoanMessage(db, { loanId: open.id, senderId: open.borrowerId, body: "On my way" }))
        .ok,
    ).toBe(true);
    const [req] = await db.select().from(loans).where(eq(loans.state, "requested")).limit(1);
    const r = await sendLoanMessage(db, { loanId: req.id, senderId: req.lenderId, body: "x" });
    expect(!r.ok && r.error).toBe("chat_closed");
  });
});
