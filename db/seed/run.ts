import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { rowsOf, type Db } from "@/db/client";
import { hashPhone } from "@/lib/auth/phone-hash";
import { CONFIG_DEFAULTS, CONFIG_DESCRIPTIONS, type ConfigKey } from "@/lib/config/schema";
import * as s from "../schema";
import { CLUSTERS, DROP_POINTS, MEMBERS } from "./data";
import {
  createRng,
  daysAgo,
  daysFromNow,
  hoursAgo,
  hoursFromNow,
  previousMonth,
  startOfMonth,
} from "./rng";

type BookFixture = {
  isbn13: string;
  title: string;
  authors: string[];
  publisher: string | null;
  publishedYear: number | null;
  language: string;
  pageCount: number | null;
  coverUrl: string | null;
  listPricePaise: number;
};

export type SeedDb = Db;

export type SeedOptions = {
  /** Fixed clock so tests can assert on relative dates. */
  now?: Date;
  /** Override auth user ids by phone (used when real Supabase Auth users exist). */
  authUserIds?: Map<string, string>;
  log?: (msg: string) => void;
};

export type SeedSummary = {
  clusters: number;
  dropPoints: number;
  books: number;
  members: number;
  copies: number;
  loans: Record<string, number>;
  ledgerEntries: number;
  loanPayments: number;
};

const TABLES_IN_DELETE_ORDER = [
  "cron_runs",
  "admin_actions",
  "events",
  "notifications",
  "trust_events",
  "ledger_entries",
  "payouts",
  "loan_payments",
  "webhook_events",
  "disputes",
  "loan_messages",
  "loan_photos",
  "loans",
  "copies",
  "books",
  "drop_points",
  "otp_attempts",
  "cluster_waitlist",
  "members",
  "clusters",
  "config",
];

function loadBooks(): BookFixture[] {
  const file = path.resolve(__dirname, "../fixtures/books.json");
  return JSON.parse(readFileSync(file, "utf8")) as BookFixture[];
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
function handoffCode(rng: ReturnType<typeof createRng>) {
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[rng.int(0, CODE_ALPHABET.length - 1)];
  return out;
}

export async function seed(db: SeedDb, opts: SeedOptions = {}): Promise<SeedSummary> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const rng = createRng(20260921);
  const TRUST = CONFIG_DEFAULTS.trust_weights;

  // ---- wipe -------------------------------------------------------------
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES_IN_DELETE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`),
  );
  log("truncated");

  // ---- config -----------------------------------------------------------
  await db.insert(s.config).values(
    (Object.keys(CONFIG_DEFAULTS) as ConfigKey[]).map((key) => ({
      key,
      value: CONFIG_DEFAULTS[key],
      description: CONFIG_DESCRIPTIONS[key],
    })),
  );

  // ---- clusters, drop points -------------------------------------------
  const clusters = await db.insert(s.clusters).values(CLUSTERS).returning();
  const central = clusters.find((c) => c.slug === "central-east")!;

  const dropPoints = await db
    .insert(s.dropPoints)
    .values(
      DROP_POINTS.map((d) => ({
        ...d,
        clusterId: central.id,
        qrSecret: randomBytes(16).toString("hex"),
      })),
    )
    .returning();

  // ---- books ------------------------------------------------------------
  const fixture = loadBooks();
  const books = await db
    .insert(s.books)
    .values(
      fixture.map((b) => ({
        isbn13: b.isbn13,
        title: b.title,
        authors: b.authors,
        publisher: b.publisher,
        publishedYear: b.publishedYear,
        language: b.language,
        pageCount: b.pageCount,
        coverUrl: b.coverUrl,
        listPricePaise: b.listPricePaise,
        source: "open_library" as const,
      })),
    )
    .returning();
  // Two manual entries awaiting review, so the admin queue has content.
  const manualBooks = await db
    .insert(s.books)
    .values([
      {
        title: "Malgudi Days (Indian Thought edition)",
        authors: ["R. K. Narayan"],
        language: "en",
        source: "manual",
        needsReview: true,
        reviewPhotoPath: "review/seed-malgudi.jpg",
      },
      {
        title: "Ghachar Ghochar",
        authors: ["Vivek Shanbhag"],
        language: "en",
        source: "manual",
        needsReview: true,
        reviewPhotoPath: "review/seed-ghachar.jpg",
      },
    ])
    .returning();
  const allBooks = [...books, ...manualBooks];

  // ---- members ----------------------------------------------------------
  const members = await db
    .insert(s.members)
    .values(
      MEMBERS.map((m) => {
        // Active and suspended members have paid the deposit and so have a Razorpay customer.
        const paidDeposit = m.state === "active" || m.state === "suspended";
        const createdAt = daysAgo(m.ageDays, now);
        return {
          authUserId: opts.authUserIds?.get(m.phone) ?? crypto.randomUUID(),
          phoneHash: hashPhone(m.phone),
          displayName: m.displayName,
          clusterId: central.id,
          state: m.state,
          razorpayCustomerId: paidDeposit ? `cust_seed_${m.phone.slice(-4)}` : null,
          suspendedUntil: m.state === "suspended" ? daysFromNow(60, now) : null,
          upiId: m.upiId ?? null,
          upiVerified: Boolean(m.upiId),
          isAdmin: Boolean(m.isAdmin),
          termsAcceptedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    )
    .returning();
  const byName = new Map(members.map((m) => [m.displayName!, m]));
  const active = members.filter((m) => m.state === "active");
  const canOwn = members.filter((m) => m.state !== "cancelled");

  // Waitlist entries for the two closed clusters.
  await db.insert(s.clusterWaitlist).values([
    {
      clusterId: clusters.find((c) => c.slug === "south")!.id,
      memberId: byName.get("Varun")!.id,
      pincode: "560041",
    },
    {
      clusterId: clusters.find((c) => c.slug === "north")!.id,
      memberId: byName.get("Lakshmi")!.id,
      pincode: "560003",
    },
  ]);

  // ---- copies -----------------------------------------------------------
  // 300 copies. Active members own most; registered members own a few each,
  // respecting the new-account cap (10) for accounts under 7 days old.
  const conditions = ["like_new", "good", "good", "good", "worn"] as const;
  const copyRows: (typeof s.copies.$inferInsert)[] = [];
  const shuffledBooks = rng.shuffle(books);
  let bookIdx = 0;
  const nextBook = () => shuffledBooks[bookIdx++ % shuffledBooks.length];

  for (const owner of canOwn) {
    const ageDays = Math.round((now.getTime() - owner.createdAt.getTime()) / 86_400_000);
    const isNew = ageDays < CONFIG_DEFAULTS.new_account_age_days;
    const target =
      owner.state === "active"
        ? rng.int(12, 22)
        : owner.state === "registered"
          ? rng.int(2, 9)
          : rng.int(4, 8);
    const count = isNew ? Math.min(target, CONFIG_DEFAULTS.new_account_listing_cap) : target;
    for (let i = 0; i < count; i++) {
      const book = nextBook();
      const listPrice = book.listPricePaise ?? 39900;
      const adj = 1 + (rng.int(-30, 30) / 100) * (rng.chance(0.3) ? 1 : 0);
      const handoffs: Array<"meetup" | "courier"> = rng.chance(0.7)
        ? ["meetup", "courier"]
        : rng.chance(0.5)
          ? ["meetup"]
          : ["courier"];
      copyRows.push({
        bookId: book.id,
        ownerId: owner.id,
        clusterId: central.id,
        rentalPricePaise: rng.chance(0.2) ? 0 : rng.pick([2000, 3000, 3000, 5000, 5000, 8000]),
        loanPeriodDays: rng.pick([14, 21, 21, 28]),
        condition: rng.pick(conditions),
        replacementValuePaise: Math.round((listPrice * adj) / 100) * 100,
        listingPhotoPath: `listings/seed/${book.isbn13}-${owner.id.slice(0, 8)}.jpg`,
        allowedHandoffs: handoffs,
        minBorrowerTrust: rng.chance(0.15) ? rng.pick([30, 50, 70]) : 0,
        availability: rng.chance(0.08) ? "unlisted" : "available",
        verificationStatus: owner.state === "active" && rng.chance(0.4) ? "verified" : "unverified",
        lastActivityAt: daysAgo(rng.int(0, 120), now),
        createdAt: daysAgo(Math.min(ageDays, rng.int(0, ageDays)), now),
      });
    }
  }
  // Top up to exactly 300 with extra copies for active members.
  while (copyRows.length < 300) {
    const owner = rng.pick(active);
    const book = nextBook();
    copyRows.push({
      bookId: book.id,
      ownerId: owner.id,
      clusterId: central.id,
      condition: rng.pick(conditions),
      replacementValuePaise: book.listPricePaise ?? 39900,
      rentalPricePaise: rng.pick([0, 3000, 5000]),
      loanPeriodDays: 21,
      listingPhotoPath: `listings/seed/${book.isbn13}-${owner.id.slice(0, 8)}.jpg`,
      allowedHandoffs: ["meetup", "courier"],
      availability: "available",
      verificationStatus: rng.chance(0.4) ? "verified" : "unverified",
      lastActivityAt: daysAgo(rng.int(0, 120), now),
    });
  }
  const copies = await db.insert(s.copies).values(copyRows.slice(0, 300)).returning();
  log(`copies: ${copies.length}`);

  // ---- loans ------------------------------------------------------------
  // Pick available copies whose owner is active; borrower is a different active member.
  const copyPool = rng.shuffle(copies.filter((c) => c.availability === "available"));
  const ownerOf = new Map(members.map((m) => [m.id, m]));
  const usedCopies = new Set<string>();
  const takeCopy = (pred?: (c: (typeof copies)[number]) => boolean) => {
    const c = copyPool.find(
      (x) =>
        !usedCopies.has(x.id) && ownerOf.get(x.ownerId)!.state === "active" && (!pred || pred(x)),
    )!;
    usedCopies.add(c.id);
    return c;
  };
  const borrowerFor = (lenderId: string, exclude: string[] = []) =>
    rng.pick(active.filter((m) => m.id !== lenderId && !exclude.includes(m.id)));

  const lastMonth = previousMonth(now);
  const thisMonth = startOfMonth(now);

  type LoanSpec = {
    state: (typeof s.loanState.enumValues)[number];
    /** `drop_point` loans are legacy data from before the feature was retired. */
    method: "meetup" | "drop_point" | "courier";
    /** Accepted but not yet paid; the default is paid at acceptance. */
    unpaid?: boolean;
    ageDays: number; // when requested
    extra?: (l: typeof s.loans.$inferInsert, copy: (typeof copies)[number]) => void;
    copyAvailability: (typeof s.copyAvailability.enumValues)[number];
    borrowerState?: "suspended";
  };

  const dp0 = dropPoints[0];
  const dp1 = dropPoints[1];

  const specs: LoanSpec[] = [
    // open requests
    { state: "requested", method: "meetup", ageDays: 0.5, copyAvailability: "requested" },
    { state: "requested", method: "drop_point", ageDays: 1.5, copyAvailability: "requested" },
    // near the 48h timeout, for the cron test
    { state: "requested", method: "meetup", ageDays: 1.95, copyAvailability: "requested" },
    // closed without a loan
    {
      state: "declined",
      method: "meetup",
      ageDays: 6,
      copyAvailability: "available",
      extra: (l) => {
        l.respondedAt = daysAgo(5.8, now);
        l.declineReason = "not_available";
      },
    },
    {
      state: "declined",
      method: "meetup",
      ageDays: 9,
      copyAvailability: "unlisted",
      extra: (l) => {
        l.respondedAt = daysAgo(8.9, now);
        l.declineReason = "no_longer_have";
      },
    },
    { state: "expired", method: "drop_point", ageDays: 7, copyAvailability: "available" },
    // accepted, borrower still has to pay (Requirement 5)
    {
      state: "accepted",
      method: "meetup",
      ageDays: 1,
      copyAvailability: "requested",
      unpaid: true,
      extra: (l) => {
        l.respondedAt = hoursAgo(20, now);
        l.paymentDueAt = hoursFromNow(4, now);
      },
    },
    {
      state: "accepted",
      method: "drop_point",
      ageDays: 3,
      copyAvailability: "requested",
      extra: (l) => {
        l.respondedAt = daysAgo(2.8, now);
        l.dropPointId = dp0.id;
        l.handoffCode = handoffCode(rng);
        l.outLenderConfirmedAt = daysAgo(2, now);
      },
    },
    // one-sided meet-up confirmation, ready for the 72h auto-confirm
    {
      state: "accepted",
      method: "meetup",
      ageDays: 5,
      copyAvailability: "requested",
      extra: (l) => {
        l.respondedAt = daysAgo(4.5, now);
        l.outLenderConfirmedAt = daysAgo(3.2, now);
      },
    },
    // on loan
    ...Array.from({ length: 6 }, (_, i): LoanSpec => ({
      state: "on_loan",
      method: i % 2 ? "drop_point" : i === 2 ? "courier" : "meetup",
      ageDays: 4 + i * 2,
      copyAvailability: "on_loan",
      extra: (l) => {
        const handed = daysAgo(2 + i * 2, now);
        l.respondedAt = daysAgo(3 + i * 2, now);
        l.outLenderConfirmedAt = handed;
        l.outBorrowerConfirmedAt = handed;
        l.handedOffAt = handed;
        l.dueAt = daysFromNow(21 - (2 + i * 2), now);
        if (i % 2) {
          l.dropPointId = dp1.id;
          l.handoffCode = handoffCode(rng);
        }
        if (i === 1) {
          l.extended = true;
          l.dueAt = daysFromNow(21 + 7 - 4, now);
        }
      },
    })),
    // due in 3 days (reminder boundary)
    {
      state: "on_loan",
      method: "meetup",
      ageDays: 19,
      copyAvailability: "on_loan",
      extra: (l) => {
        const h = daysAgo(18, now);
        l.respondedAt = daysAgo(18.5, now);
        l.outLenderConfirmedAt = h;
        l.outBorrowerConfirmedAt = h;
        l.handedOffAt = h;
        l.dueAt = daysFromNow(3, now);
      },
    },
    // overdue
    {
      state: "overdue",
      method: "meetup",
      ageDays: 26,
      copyAvailability: "on_loan",
      extra: (l) => {
        const h = daysAgo(25, now);
        l.respondedAt = daysAgo(25.5, now);
        l.outLenderConfirmedAt = h;
        l.outBorrowerConfirmedAt = h;
        l.handedOffAt = h;
        l.dueAt = daysAgo(4, now);
      },
    },
    // overdue and about to be lost (day 14)
    {
      state: "overdue",
      method: "drop_point",
      ageDays: 37,
      copyAvailability: "on_loan",
      extra: (l) => {
        const h = daysAgo(36, now);
        l.respondedAt = daysAgo(36.5, now);
        l.outLenderConfirmedAt = h;
        l.outBorrowerConfirmedAt = h;
        l.handedOffAt = h;
        l.dueAt = daysAgo(13.9, now);
        l.dropPointId = dp0.id;
        l.handoffCode = handoffCode(rng);
      },
    },
    // returned: 5 last month (count toward the pool run), 4 this month
    ...Array.from({ length: 9 }, (_, i): LoanSpec => {
      const inLastMonth = i < 5;
      const returnedAt = inLastMonth
        ? new Date(lastMonth.getTime() + (3 + i * 5) * 86_400_000)
        : new Date(
            Math.min(thisMonth.getTime() + (1 + i) * 86_400_000, now.getTime() - 3 * 86_400_000),
          );
      const handed = new Date(returnedAt.getTime() - 18 * 86_400_000);
      return {
        state: "returned",
        method: i % 3 === 0 ? "drop_point" : "meetup",
        ageDays: (now.getTime() - handed.getTime()) / 86_400_000 + 1,
        copyAvailability: "available",
        extra: (l) => {
          l.respondedAt = new Date(handed.getTime() - 86_400_000);
          l.outLenderConfirmedAt = handed;
          l.outBorrowerConfirmedAt = handed;
          l.handedOffAt = handed;
          l.dueAt = new Date(handed.getTime() + 21 * 86_400_000);
          l.returnBorrowerConfirmedAt = returnedAt;
          l.returnLenderConfirmedAt = returnedAt;
          l.returnedAt = returnedAt;
          l.returnCondition = "good";
          if (i % 3 === 0) {
            l.dropPointId = dp1.id;
            l.handoffCode = handoffCode(rng);
          }
          if (i === 2) l.autoConfirmedSide = "lender";
        },
      };
    }),
    // returned within the last 24h, so a dispute can still be opened
    {
      state: "returned",
      method: "meetup",
      ageDays: 22,
      copyAvailability: "available",
      extra: (l) => {
        const h = daysAgo(21, now);
        const r = hoursAgo(20, now);
        l.respondedAt = daysAgo(21.5, now);
        l.outLenderConfirmedAt = h;
        l.outBorrowerConfirmedAt = h;
        l.handedOffAt = h;
        l.dueAt = daysFromNow(0, now);
        l.returnBorrowerConfirmedAt = r;
        l.returnLenderConfirmedAt = r;
        l.returnedAt = r;
        l.returnCondition = "worn";
      },
    },
    // lost (borrower is the suspended member)
    {
      state: "lost",
      method: "meetup",
      ageDays: 60,
      copyAvailability: "lost",
      borrowerState: "suspended",
      extra: (l) => {
        const h = daysAgo(58, now);
        l.respondedAt = daysAgo(59, now);
        l.outLenderConfirmedAt = h;
        l.outBorrowerConfirmedAt = h;
        l.handedOffAt = h;
        l.dueAt = daysAgo(37, now);
      },
    },
    // disputed (open)
    {
      state: "disputed",
      method: "meetup",
      ageDays: 25,
      copyAvailability: "available",
      extra: (l) => {
        const h = daysAgo(24, now);
        const r = daysAgo(1.5, now);
        l.respondedAt = daysAgo(24.5, now);
        l.outLenderConfirmedAt = h;
        l.outBorrowerConfirmedAt = h;
        l.handedOffAt = h;
        l.dueAt = daysAgo(3, now);
        l.returnBorrowerConfirmedAt = r;
        l.returnLenderConfirmedAt = r;
        l.returnedAt = r;
        l.returnCondition = "worn";
      },
    },
    // resolved (last month, partial charge)
    {
      state: "resolved",
      method: "drop_point",
      ageDays: 45,
      copyAvailability: "available",
      extra: (l) => {
        const h = daysAgo(44, now);
        const r = new Date(lastMonth.getTime() + 20 * 86_400_000);
        l.respondedAt = daysAgo(44.5, now);
        l.outLenderConfirmedAt = h;
        l.outBorrowerConfirmedAt = h;
        l.handedOffAt = h;
        l.dueAt = daysAgo(23, now);
        l.returnBorrowerConfirmedAt = r;
        l.returnLenderConfirmedAt = r;
        l.returnedAt = r;
        l.returnCondition = "worn";
        l.dropPointId = dp0.id;
        l.handoffCode = handoffCode(rng);
      },
    },
  ];

  const loanRows: (typeof s.loans.$inferInsert)[] = [];
  const copyUpdates = new Map<string, (typeof s.copyAvailability.enumValues)[number]>();
  const suspended = members.find((m) => m.state === "suspended")!;

  for (const spec of specs) {
    // Legacy drop-point loans predate the current listing options, so any copy will do.
    const copy = takeCopy(
      (c) => spec.method === "drop_point" || c.allowedHandoffs.includes(spec.method),
    );
    const lender = ownerOf.get(copy.ownerId)!;
    const borrower = spec.borrowerState === "suspended" ? suspended : borrowerFor(lender.id);
    const requestedAt = daysAgo(spec.ageDays, now);
    const row: typeof s.loans.$inferInsert = {
      copyId: copy.id,
      bookId: copy.bookId,
      lenderId: lender.id,
      borrowerId: borrower.id,
      state: spec.state,
      handoffMethod: spec.method,
      requestedAt,
      createdAt: requestedAt,
    };
    spec.extra?.(row, copy);
    // Rental snapshot and payment (Requirement 5): anything past `requested` was paid on acceptance.
    row.rentalPaise = copy.rentalPricePaise;
    row.platformFeePaise = Math.floor(
      (copy.rentalPricePaise * CONFIG_DEFAULTS.platform_fee_pct) / 100,
    );
    if (spec.state !== "requested" && spec.state !== "declined" && !spec.unpaid) {
      row.paidAt = row.respondedAt ?? requestedAt;
    }
    loanRows.push(row);
    copyUpdates.set(copy.id, spec.copyAvailability);
  }
  const loans = await db.insert(s.loans).values(loanRows).returning();

  for (const [copyId, availability] of copyUpdates) {
    await db
      .update(s.copies)
      .set({
        availability,
        // a completed loan verifies the copy
        ...(availability === "available" ? { verificationStatus: "verified" as const } : {}),
        declineCount: availability === "unlisted" ? 3 : 0,
      })
      .where(sql`${s.copies.id} = ${copyId}`);
  }
  // Occupancy: one drop-point loan has been dropped but not collected.
  await db
    .update(s.dropPoints)
    .set({ occupancy: 1 })
    .where(sql`${s.dropPoints.id} = ${dp0.id}`);

  // Photos, messages, events for loans that got past acceptance.
  const photoRows: (typeof s.loanPhotos.$inferInsert)[] = [];
  const messageRows: (typeof s.loanMessages.$inferInsert)[] = [];
  const eventRows: (typeof s.events.$inferInsert)[] = [];
  for (const loan of loans) {
    eventRows.push({
      aggregate: "loan",
      aggregateId: loan.id,
      type: "loan.requested",
      actorId: loan.borrowerId,
      payload: { copyId: loan.copyId },
      createdAt: loan.requestedAt,
    });
    if (loan.respondedAt) {
      eventRows.push({
        aggregate: "loan",
        aggregateId: loan.id,
        type: loan.state === "declined" ? "loan.declined" : "loan.accepted",
        actorId: loan.lenderId,
        payload: {},
        createdAt: loan.respondedAt,
      });
      messageRows.push(
        {
          loanId: loan.id,
          senderId: loan.lenderId,
          body: "Hi! When works for you?",
          createdAt: new Date(loan.respondedAt.getTime() + 60_000),
        },
        {
          loanId: loan.id,
          senderId: loan.borrowerId,
          body: "Tomorrow evening at the 12th Main cafe?",
          createdAt: new Date(loan.respondedAt.getTime() + 600_000),
        },
      );
    }
    if (loan.outLenderConfirmedAt)
      photoRows.push({
        loanId: loan.id,
        takenBy: loan.lenderId,
        phase: "out",
        storagePath: `loans/seed/${loan.id}/out-lender.jpg`,
        createdAt: loan.outLenderConfirmedAt,
      });
    if (loan.outBorrowerConfirmedAt)
      photoRows.push({
        loanId: loan.id,
        takenBy: loan.borrowerId,
        phase: "out",
        storagePath: `loans/seed/${loan.id}/out-borrower.jpg`,
        createdAt: loan.outBorrowerConfirmedAt,
      });
    if (loan.handedOffAt)
      eventRows.push({
        aggregate: "loan",
        aggregateId: loan.id,
        type: "loan.on_loan",
        payload: { dueAt: loan.dueAt },
        createdAt: loan.handedOffAt,
      });
    if (loan.returnLenderConfirmedAt)
      photoRows.push({
        loanId: loan.id,
        takenBy: loan.lenderId,
        phase: "return",
        storagePath: `loans/seed/${loan.id}/return-lender.jpg`,
        condition: loan.returnCondition,
        createdAt: loan.returnLenderConfirmedAt,
      });
    if (loan.returnedAt)
      eventRows.push({
        aggregate: "loan",
        aggregateId: loan.id,
        type: "loan.returned",
        payload: { condition: loan.returnCondition },
        createdAt: loan.returnedAt,
      });
    if (loan.state === "lost")
      eventRows.push({
        aggregate: "loan",
        aggregateId: loan.id,
        type: "loan.lost",
        payload: {},
        createdAt: daysAgo(23, now),
      });
  }
  await db.insert(s.loanPhotos).values(photoRows);
  await db.insert(s.loanMessages).values(messageRows);
  await db.insert(s.events).values(eventRows);

  // Disputes
  const disputedLoan = loans.find((l) => l.state === "disputed")!;
  const resolvedLoan = loans.find((l) => l.state === "resolved")!;
  const admin = byName.get("Ananya")!;
  await db.insert(s.disputes).values([
    {
      loanId: disputedLoan.id,
      openedBy: disputedLoan.lenderId,
      reason: "Spine cracked and several pages dog-eared; it went out like new.",
      state: "open",
      createdAt: daysAgo(1, now),
    },
    {
      loanId: resolvedLoan.id,
      openedBy: resolvedLoan.lenderId,
      reason: "Water damage on the back cover.",
      state: "resolved",
      resolution: "partial_charge",
      chargePaise: 15000,
      resolvedBy: admin.id,
      resolvedAt: daysAgo(20, now),
      resolutionNote: "Photos show new damage. Partial charge covers a replacement cover.",
    },
  ]);
  await db.insert(s.adminActions).values({
    adminId: admin.id,
    targetType: "dispute",
    targetId: resolvedLoan.id,
    action: "dispute.resolve",
    reason: "Photos show new damage. Partial charge covers a replacement cover.",
    payload: { resolution: "partial_charge", chargePaise: 15000 },
    createdAt: daysAgo(20, now),
  });

  // ---- trust events -----------------------------------------------------
  const trustRows: (typeof s.trustEvents.$inferInsert)[] = [];
  for (const loan of loans) {
    if (loan.state === "returned" || loan.state === "disputed" || loan.state === "resolved") {
      const late = loan.returnedAt! > loan.dueAt!;
      trustRows.push(
        {
          memberId: loan.borrowerId,
          kind: late ? "return_late" : "return_on_time",
          loanId: loan.id,
          delta: late ? TRUST.return_late : TRUST.return_on_time,
          createdAt: loan.returnedAt!,
        },
        {
          memberId: loan.borrowerId,
          kind: "borrow_completed",
          loanId: loan.id,
          delta: TRUST.borrow_completed,
          createdAt: loan.returnedAt!,
        },
        {
          memberId: loan.lenderId,
          kind: "lend_completed",
          loanId: loan.id,
          delta: TRUST.lend_completed,
          createdAt: loan.returnedAt!,
        },
      );
    }
    if (loan.state === "resolved")
      trustRows.push({
        memberId: loan.borrowerId,
        kind: "dispute_lost",
        loanId: loan.id,
        delta: TRUST.dispute_lost,
        createdAt: daysAgo(20, now),
      });
    if (loan.state === "lost")
      trustRows.push({
        memberId: loan.borrowerId,
        kind: "book_lost",
        loanId: loan.id,
        delta: TRUST.book_lost,
        createdAt: daysAgo(23, now),
      });
    if (loan.state === "expired")
      trustRows.push({
        memberId: loan.lenderId,
        kind: "request_ignored",
        loanId: loan.id,
        delta: TRUST.request_ignored,
        createdAt: daysAgo(5, now),
      });
  }
  await db.insert(s.trustEvents).values(trustRows);

  // ---- money ------------------------------------------------------------
  const ledger: (typeof s.ledgerEntries.$inferInsert)[] = [];
  const paying = members.filter((m) => m.state === "active" || m.state === "suspended");
  for (const m of paying) {
    ledger.push({
      memberId: m.id,
      account: "deposit",
      kind: "deposit_in",
      amountPaise: CONFIG_DEFAULTS.deposit_paise,
      razorpayRef: `pay_seed_dep_${m.phoneHash.slice(0, 8)}`,
      createdAt: m.createdAt,
    });
  }

  // Rental payments: one captured Razorpay order per paid, priced loan, and the
  // lender's credit once the book went out (design.md Rental payment).
  const paymentRows: (typeof s.loanPayments.$inferInsert)[] = [];
  for (const l of loans) {
    if (!l.paidAt || l.rentalPaise <= 0) continue;
    paymentRows.push({
      loanId: l.id,
      borrowerId: l.borrowerId,
      razorpayOrderId: `order_seed_${l.id.slice(0, 8)}`,
      razorpayPaymentId: `pay_seed_${l.id.slice(0, 8)}`,
      amountPaise: l.rentalPaise,
      status: l.state === "expired" ? "refunded" : "captured",
      paidAt: l.paidAt,
      refundedAt: l.state === "expired" ? l.paidAt : null,
      razorpayRefundId: l.state === "expired" ? `rfnd_seed_${l.id.slice(0, 8)}` : null,
      createdAt: l.paidAt,
      updatedAt: l.paidAt,
    });
    if (l.handedOffAt) {
      ledger.push({
        memberId: l.lenderId,
        account: "payout",
        kind: "rental_credit",
        amountPaise: l.rentalPaise - l.platformFeePaise,
        loanId: l.id,
        note: "Rental earned",
        createdAt: l.handedOffAt,
      });
    }
  }
  if (paymentRows.length) await db.insert(s.loanPayments).values(paymentRows);

  // Lost book: deposit charge on borrower (clamped to what is held, as postEntry
  // would do), full credit to lender; the platform absorbs any gap.
  const lostLoan = loans.find((l) => l.state === "lost")!;
  const lostCopy = copies.find((c) => c.id === lostLoan.copyId)!;
  ledger.push(
    {
      memberId: lostLoan.borrowerId,
      account: "deposit",
      kind: "deposit_charge",
      amountPaise: -Math.min(lostCopy.replacementValuePaise, CONFIG_DEFAULTS.deposit_paise),
      loanId: lostLoan.id,
      note: "Book marked lost after 14 days overdue",
      createdAt: daysAgo(23, now),
    },
    {
      memberId: lostLoan.lenderId,
      account: "payout",
      kind: "lost_book_credit",
      amountPaise: lostCopy.replacementValuePaise,
      loanId: lostLoan.id,
      createdAt: daysAgo(23, now),
    },
  );
  // Resolved dispute: partial charge.
  ledger.push(
    {
      memberId: resolvedLoan.borrowerId,
      account: "deposit",
      kind: "deposit_charge",
      amountPaise: -15000,
      loanId: resolvedLoan.id,
      note: "Dispute resolved: partial charge",
      actorId: admin.id,
      createdAt: daysAgo(20, now),
    },
    {
      memberId: resolvedLoan.lenderId,
      account: "payout",
      kind: "lost_book_credit",
      amountPaise: 15000,
      loanId: resolvedLoan.id,
      note: "Dispute resolved: partial charge",
      actorId: admin.id,
      createdAt: daysAgo(20, now),
    },
  );
  // Refund for the cancelled member.
  const cancelled = members.find((m) => m.state === "cancelled")!;
  ledger.push(
    {
      memberId: cancelled.id,
      account: "deposit",
      kind: "deposit_in",
      amountPaise: CONFIG_DEFAULTS.deposit_paise,
      createdAt: cancelled.createdAt,
    },
    {
      memberId: cancelled.id,
      account: "deposit",
      kind: "deposit_refund",
      amountPaise: -CONFIG_DEFAULTS.deposit_paise,
      razorpayRef: "rfnd_seed_1",
      createdAt: daysAgo(30, now),
    },
  );

  await db.insert(s.ledgerEntries).values(ledger);

  // Cached balances from the ledger.
  await db.execute(sql`
    update members m set
      deposit_balance_paise = coalesce((select sum(amount_paise) from ledger_entries e where e.member_id = m.id and e.account = 'deposit'), 0),
      payout_balance_paise  = coalesce((select sum(amount_paise) from ledger_entries e where e.member_id = m.id and e.account = 'payout'), 0)
  `);
  await db.execute(
    sql`update members set needs_topup = true where deposit_balance_paise < ${CONFIG_DEFAULTS.deposit_paise} and state in ('active','suspended')`,
  );

  // Payout batch for last month: balance >= threshold and verified UPI.
  const eligible = rowsOf<{ id: string; upi_id: string; payout_balance_paise: number }>(
    await db.execute(
      sql`select id, upi_id, payout_balance_paise from members where upi_verified and payout_balance_paise >= ${CONFIG_DEFAULTS.payout_threshold_paise}`,
    ),
  );
  if (eligible.length) {
    const batchId = `batch_${lastMonth.toISOString().slice(0, 7)}`;
    await db.insert(s.payouts).values(
      eligible.map((r, i) => ({
        memberId: r.id,
        month: lastMonth,
        amountPaise: Number(r.payout_balance_paise),
        upiId: r.upi_id,
        status: (i === 0 ? "paid" : "exported") as "paid" | "exported",
        batchId,
        razorpayPayoutId: i === 0 ? "pout_seed_1" : null,
        createdAt: new Date(thisMonth.getTime() + 3 * 3600_000),
      })),
    );
  }

  // Trust scores from events + age bonus, clamped.
  await db.execute(sql`
    update members m set trust_score = greatest(0, least(100,
      50 + coalesce((select sum(delta) from trust_events t where t.member_id = m.id), 0)
         + least(${TRUST.age_bonus_cap_months}, floor(extract(epoch from (now() - m.created_at)) / 2592000))::int
    ))
  `);
  // first_borrow_completed_at for anyone who has returned a book.
  await db.execute(sql`
    update members m set first_borrow_completed_at = (select min(returned_at) from loans l where l.borrower_id = m.id and l.returned_at is not null)
    where exists (select 1 from loans l where l.borrower_id = m.id and l.returned_at is not null)
  `);

  // A few notifications so the log has shape.
  await db.insert(s.notifications).values(
    loans.slice(0, 6).map((l) => ({
      memberId: l.lenderId,
      template: "request_received",
      channel: "whatsapp" as const,
      payload: {
        borrower: ownerOf.get(l.borrowerId)!.displayName ?? "",
        book: allBooks.find((b) => b.id === l.bookId)!.title,
      },
      status: "delivered" as const,
      providerRef: `ik_seed_${l.id.slice(0, 8)}`,
      loanId: l.id,
      sentAt: l.requestedAt,
      deliveredAt: new Date(l.requestedAt.getTime() + 5000),
      createdAt: l.requestedAt,
    })),
  );

  const loanCounts: Record<string, number> = {};
  for (const l of loans) loanCounts[l.state] = (loanCounts[l.state] ?? 0) + 1;

  return {
    clusters: clusters.length,
    dropPoints: dropPoints.length,
    books: allBooks.length,
    members: members.length,
    copies: copies.length,
    loans: loanCounts,
    ledgerEntries: ledger.length,
    loanPayments: paymentRows.length,
  };
}
