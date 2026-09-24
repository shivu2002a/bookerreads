import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@/db/client";
import {
  books,
  copies,
  disputes,
  dropPoints,
  events,
  loanMessages,
  loanPhotos,
  loans,
  members,
} from "@/db/schema";
import type { LoanState, Party } from "./types";

export const OPEN_STATES: LoanState[] = ["requested", "accepted", "on_loan", "overdue"];

const lenderM = alias(members, "lender");
const borrowerM = alias(members, "borrower");

const memberPublic = (m: typeof lenderM | typeof borrowerM) => ({
  id: m.id,
  displayName: m.displayName,
  trustScore: m.trustScore,
});

export type LoanListItem = {
  id: string;
  state: LoanState;
  handoffMethod: "meetup" | "drop_point" | "courier";
  requestedAt: Date;
  respondedAt: Date | null;
  dueAt: Date | null;
  returnedAt: Date | null;
  book: { id: string; title: string; authors: string[]; coverUrl: string | null };
  copy: { id: string; condition: "like_new" | "good" | "worn"; listingPhotoPath: string };
  lender: { id: string; displayName: string | null; trustScore: number };
  borrower: { id: string; displayName: string | null; trustScore: number; onTimeReturns: number };
  outLenderConfirmedAt: Date | null;
  outBorrowerConfirmedAt: Date | null;
  returnLenderConfirmedAt: Date | null;
  returnBorrowerConfirmedAt: Date | null;
};

const onTimeReturns = sql<number>`(
  select count(*) from loans l2
  where l2.borrower_id = ${borrowerM}.id and l2.state in ('returned','disputed','resolved')
    and l2.returned_at is not null and l2.due_at is not null and l2.returned_at <= l2.due_at
)`;

function baseSelect(db: DbOrTx) {
  return db
    .select({
      id: loans.id,
      state: loans.state,
      handoffMethod: loans.handoffMethod,
      requestedAt: loans.requestedAt,
      respondedAt: loans.respondedAt,
      dueAt: loans.dueAt,
      returnedAt: loans.returnedAt,
      outLenderConfirmedAt: loans.outLenderConfirmedAt,
      outBorrowerConfirmedAt: loans.outBorrowerConfirmedAt,
      returnLenderConfirmedAt: loans.returnLenderConfirmedAt,
      returnBorrowerConfirmedAt: loans.returnBorrowerConfirmedAt,
      bookId: books.id,
      title: books.title,
      authors: books.authors,
      coverUrl: books.coverUrl,
      copyId: copies.id,
      condition: copies.condition,
      listingPhotoPath: copies.listingPhotoPath,
      lender: memberPublic(lenderM),
      borrower: memberPublic(borrowerM),
      onTimeReturns: onTimeReturns.as("on_time_returns"),
    })
    .from(loans)
    .innerJoin(books, eq(books.id, loans.bookId))
    .innerJoin(copies, eq(copies.id, loans.copyId))
    .innerJoin(lenderM, eq(lenderM.id, loans.lenderId))
    .innerJoin(borrowerM, eq(borrowerM.id, loans.borrowerId));
}

type BaseRow = Awaited<ReturnType<ReturnType<typeof baseSelect>["execute"]>>[number];

function toItem(r: BaseRow): LoanListItem {
  return {
    id: r.id,
    state: r.state,
    handoffMethod: r.handoffMethod,
    requestedAt: r.requestedAt,
    respondedAt: r.respondedAt,
    dueAt: r.dueAt,
    returnedAt: r.returnedAt,
    outLenderConfirmedAt: r.outLenderConfirmedAt,
    outBorrowerConfirmedAt: r.outBorrowerConfirmedAt,
    returnLenderConfirmedAt: r.returnLenderConfirmedAt,
    returnBorrowerConfirmedAt: r.returnBorrowerConfirmedAt,
    book: { id: r.bookId, title: r.title, authors: r.authors, coverUrl: r.coverUrl },
    copy: { id: r.copyId, condition: r.condition, listingPhotoPath: r.listingPhotoPath },
    lender: r.lender,
    borrower: { ...r.borrower, onTimeReturns: Number(r.onTimeReturns) },
  };
}

/** Requests page, lender side: open requests first, then recent history. */
export async function listIncoming(
  db: DbOrTx,
  lenderId: string,
  limit = 50,
): Promise<LoanListItem[]> {
  const rows = await baseSelect(db)
    .where(eq(loans.lenderId, lenderId))
    .orderBy(
      desc(sql`${loans.state} in ('requested','accepted','on_loan','overdue')`),
      desc(loans.requestedAt),
    )
    .limit(limit);
  return rows.map(toItem);
}

/** Requests page, borrower side. */
export async function listOutgoing(
  db: DbOrTx,
  borrowerId: string,
  limit = 50,
): Promise<LoanListItem[]> {
  const rows = await baseSelect(db)
    .where(eq(loans.borrowerId, borrowerId))
    .orderBy(
      desc(sql`${loans.state} in ('requested','accepted','on_loan','overdue')`),
      desc(loans.requestedAt),
    )
    .limit(limit);
  return rows.map(toItem);
}

export async function countOpenLoans(db: DbOrTx, borrowerId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(loans)
    .where(and(eq(loans.borrowerId, borrowerId), inArray(loans.state, OPEN_STATES)));
  return Number(n);
}

export type LoanDetail = LoanListItem & {
  viewerParty: Party;
  copyId: string;
  dropPoint: { id: string; name: string; address: string; hours: unknown } | null;
  /** Only the parties see the code; both need it for a drop-point handoff. */
  handoffCode: string | null;
  extended: boolean;
  handedOffAt: Date | null;
  returnCondition: "like_new" | "good" | "worn" | null;
  autoConfirmedSide: Party | null;
  declineReason: "not_available" | "no_longer_have" | "other" | null;
  timeline: Array<{ id: string; type: string; at: Date; actorId: string | null; payload: unknown }>;
  photos: Array<{
    id: string;
    phase: "out" | "return";
    takenBy: string;
    storagePath: string;
    condition: string | null;
    at: Date;
  }>;
  messages: Array<{ id: string; senderId: string; body: string; at: Date }>;
  dispute: {
    id: string;
    state: "open" | "resolved";
    reason: string;
    resolution: string | null;
    note: string | null;
    openedBy: string;
    at: Date;
  } | null;
};

/**
 * Everything the loan page needs, for one of the two parties (or an admin).
 * Returns null when the viewer is not a party and not an admin.
 */
export async function getLoanForViewer(
  db: DbOrTx,
  loanId: string,
  viewer: { id: string; isAdmin: boolean },
): Promise<LoanDetail | null> {
  const [row] = await baseSelect(db).where(eq(loans.id, loanId));
  if (!row) return null;
  const item = toItem(row);
  const party: Party | null =
    item.lender.id === viewer.id ? "lender" : item.borrower.id === viewer.id ? "borrower" : null;
  if (!party && !viewer.isAdmin) return null;

  const [extra] = await db
    .select({
      handoffCode: loans.handoffCode,
      extended: loans.extended,
      handedOffAt: loans.handedOffAt,
      returnCondition: loans.returnCondition,
      autoConfirmedSide: loans.autoConfirmedSide,
      declineReason: loans.declineReason,
      dropPointId: dropPoints.id,
      dropPointName: dropPoints.name,
      dropPointAddress: dropPoints.address,
      dropPointHours: dropPoints.hours,
    })
    .from(loans)
    .leftJoin(dropPoints, eq(dropPoints.id, loans.dropPointId))
    .where(eq(loans.id, loanId));

  const [timeline, photos, messages, [dispute]] = await Promise.all([
    db
      .select({
        id: events.id,
        type: events.type,
        at: events.createdAt,
        actorId: events.actorId,
        payload: events.payload,
      })
      .from(events)
      .where(and(eq(events.aggregate, "loan"), eq(events.aggregateId, loanId)))
      .orderBy(asc(events.createdAt)),
    db
      .select({
        id: loanPhotos.id,
        phase: loanPhotos.phase,
        takenBy: loanPhotos.takenBy,
        storagePath: loanPhotos.storagePath,
        condition: loanPhotos.condition,
        at: loanPhotos.createdAt,
      })
      .from(loanPhotos)
      .where(eq(loanPhotos.loanId, loanId))
      .orderBy(asc(loanPhotos.createdAt)),
    db
      .select({
        id: loanMessages.id,
        senderId: loanMessages.senderId,
        body: loanMessages.body,
        at: loanMessages.createdAt,
      })
      .from(loanMessages)
      .where(eq(loanMessages.loanId, loanId))
      .orderBy(asc(loanMessages.createdAt)),
    db
      .select({
        id: disputes.id,
        state: disputes.state,
        reason: disputes.reason,
        resolution: disputes.resolution,
        note: disputes.resolutionNote,
        openedBy: disputes.openedBy,
        at: disputes.createdAt,
      })
      .from(disputes)
      .where(eq(disputes.loanId, loanId)),
  ]);

  return {
    ...item,
    viewerParty: party ?? "lender",
    copyId: item.copy.id,
    dropPoint: extra.dropPointId
      ? {
          id: extra.dropPointId,
          name: extra.dropPointName!,
          address: extra.dropPointAddress!,
          hours: extra.dropPointHours,
        }
      : null,
    handoffCode: extra.handoffCode,
    extended: extra.extended,
    handedOffAt: extra.handedOffAt,
    returnCondition: extra.returnCondition,
    autoConfirmedSide: extra.autoConfirmedSide,
    declineReason: extra.declineReason,
    timeline,
    photos,
    messages,
    dispute: dispute ?? null,
  };
}

/** Chat stays open from acceptance until 48 h after the loan closes (design.md loan_messages). */
export function isChatOpen(
  loan: { state: LoanState; returnedAt: Date | null; respondedAt: Date | null },
  now = new Date(),
  windowHours = 48,
): boolean {
  if (["accepted", "on_loan", "overdue", "disputed"].includes(loan.state)) return true;
  if (["returned", "resolved", "lost"].includes(loan.state)) {
    const closedAt = loan.returnedAt ?? loan.respondedAt;
    return closedAt ? now.getTime() - closedAt.getTime() < windowHours * 3_600_000 : false;
  }
  return false;
}

export async function sendLoanMessage(
  db: DbOrTx,
  input: { loanId: string; senderId: string; body: string },
) {
  const [loan] = await db
    .select({
      state: loans.state,
      lenderId: loans.lenderId,
      borrowerId: loans.borrowerId,
      returnedAt: loans.returnedAt,
      respondedAt: loans.respondedAt,
    })
    .from(loans)
    .where(eq(loans.id, input.loanId));
  if (!loan) return { ok: false as const, error: "not_found" as const };
  if (loan.lenderId !== input.senderId && loan.borrowerId !== input.senderId)
    return { ok: false as const, error: "not_a_party" as const };
  if (!isChatOpen(loan)) return { ok: false as const, error: "chat_closed" as const };
  const [m] = await db
    .insert(loanMessages)
    .values({ loanId: input.loanId, senderId: input.senderId, body: input.body })
    .returning();
  return { ok: true as const, message: m };
}

export async function isLoanParty(db: DbOrTx, loanId: string, memberId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: loans.id })
    .from(loans)
    .where(
      and(
        eq(loans.id, loanId),
        sql`${loans.lenderId} = ${memberId} or ${loans.borrowerId} = ${memberId}`,
      ),
    );
  return Boolean(row);
}

export async function listMessagesSince(db: DbOrTx, loanId: string, since: Date | null) {
  return db
    .select({
      id: loanMessages.id,
      senderId: loanMessages.senderId,
      body: loanMessages.body,
      at: loanMessages.createdAt,
    })
    .from(loanMessages)
    .where(
      and(
        eq(loanMessages.loanId, loanId),
        since ? sql`${loanMessages.createdAt} > ${since}` : sql`true`,
      ),
    )
    .orderBy(asc(loanMessages.createdAt));
}
