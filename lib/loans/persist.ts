import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { copies, dropPoints, events, loans, members } from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { evaluateActivation } from "@/lib/members/activation";
import { applyEffects } from "./effects";
import { loanError, requestLoan, transition } from "./machine";
import type {
  Actor,
  BorrowerSnapshot,
  CopySnapshot,
  Ctx,
  DropPointSnapshot,
  Loan,
  LoanError,
  LoanEvent,
  MachineConfig,
  RequestInput,
} from "./types";

export type LoanRow = typeof loans.$inferSelect;

export type PersistResult =
  { ok: true; loan: LoanRow; eventType: string } | { ok: false; error: LoanError };

export type PersistDeps = {
  now?: () => Date;
  newId?: () => string;
  newHandoffCode?: () => string;
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function generateHandoffCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function machineConfig(config: AppConfig): MachineConfig {
  return {
    request_timeout_hours: config.request_timeout_hours,
    payment_window_hours: config.payment_window_hours,
    platform_fee_pct: config.platform_fee_pct,
    max_open_loans: config.max_open_loans,
    handoff_timeout_days: config.handoff_timeout_days,
    handoff_auto_confirm_hours: config.handoff_auto_confirm_hours,
    extension_days: config.extension_days,
    overdue_to_lost_days: config.overdue_to_lost_days,
    dispute_window_hours: config.dispute_window_hours,
    lost_suspension_days: config.lost_suspension_days,
    copy_decline_unlist_threshold: config.copy_decline_unlist_threshold,
    min_trust_score: config.borrow_gate.min_trust_score,
  };
}

// ---------------------------------------------------------------------------
// row <-> machine
// ---------------------------------------------------------------------------

export function rowToLoan(r: LoanRow): Loan {
  return {
    id: r.id,
    copyId: r.copyId,
    bookId: r.bookId,
    lenderId: r.lenderId,
    borrowerId: r.borrowerId,
    state: r.state,
    handoffMethod: r.handoffMethod,
    dropPointId: r.dropPointId,
    handoffCode: r.handoffCode,
    requestedAt: r.requestedAt,
    respondedAt: r.respondedAt,
    outLenderConfirmedAt: r.outLenderConfirmedAt,
    outBorrowerConfirmedAt: r.outBorrowerConfirmedAt,
    handedOffAt: r.handedOffAt,
    dueAt: r.dueAt,
    extended: r.extended,
    returnBorrowerConfirmedAt: r.returnBorrowerConfirmedAt,
    returnLenderConfirmedAt: r.returnLenderConfirmedAt,
    returnedAt: r.returnedAt,
    returnCondition: r.returnCondition,
    autoConfirmedSide: r.autoConfirmedSide,
    declineReason: r.declineReason,
    rentalPaise: r.rentalPaise,
    platformFeePaise: r.platformFeePaise,
    paymentDueAt: r.paymentDueAt,
    paidAt: r.paidAt,
  };
}

function loanToRow(l: Loan): typeof loans.$inferInsert {
  return {
    id: l.id,
    copyId: l.copyId,
    bookId: l.bookId,
    lenderId: l.lenderId,
    borrowerId: l.borrowerId,
    state: l.state,
    handoffMethod: l.handoffMethod,
    dropPointId: l.dropPointId,
    handoffCode: l.handoffCode,
    requestedAt: l.requestedAt,
    respondedAt: l.respondedAt,
    outLenderConfirmedAt: l.outLenderConfirmedAt,
    outBorrowerConfirmedAt: l.outBorrowerConfirmedAt,
    handedOffAt: l.handedOffAt,
    dueAt: l.dueAt,
    extended: l.extended,
    returnBorrowerConfirmedAt: l.returnBorrowerConfirmedAt,
    returnLenderConfirmedAt: l.returnLenderConfirmedAt,
    returnedAt: l.returnedAt,
    returnCondition: l.returnCondition,
    autoConfirmedSide: l.autoConfirmedSide,
    declineReason: l.declineReason,
    rentalPaise: l.rentalPaise,
    platformFeePaise: l.platformFeePaise,
    paymentDueAt: l.paymentDueAt,
    paidAt: l.paidAt,
  };
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

async function lockCopy(tx: Tx, copyId: string): Promise<CopySnapshot | null> {
  const [c] = await tx.select().from(copies).where(eq(copies.id, copyId)).for("update");
  if (!c) return null;
  return {
    id: c.id,
    bookId: c.bookId,
    ownerId: c.ownerId,
    clusterId: c.clusterId,
    availability: c.availability,
    minBorrowerTrust: c.minBorrowerTrust,
    allowedHandoffs: c.allowedHandoffs,
    declineCount: c.declineCount,
    verificationStatus: c.verificationStatus,
    replacementValuePaise: c.replacementValuePaise,
    rentalPricePaise: c.rentalPricePaise,
    loanPeriodDays: c.loanPeriodDays,
  };
}

async function borrowerSnapshot(
  tx: Tx,
  memberId: string,
  config: AppConfig,
): Promise<BorrowerSnapshot | null> {
  const [m] = await tx
    .select({
      id: members.id,
      state: members.state,
      clusterId: members.clusterId,
      trustScore: members.trustScore,
      suspendedUntil: members.suspendedUntil,
      needsTopup: members.needsTopup,
      firstBorrowCompletedAt: members.firstBorrowCompletedAt,
    })
    .from(members)
    .where(eq(members.id, memberId));
  if (!m) return null;

  const [counts] = await tx
    .select({
      open: sql<number>`count(*) filter (where ${loans.state} in ('requested','accepted','on_loan','overdue'))`,
      pending: sql<number>`count(*) filter (where ${loans.state} in ('requested','accepted'))`,
    })
    .from(loans)
    .where(eq(loans.borrowerId, memberId));

  const activation = await evaluateActivation(tx, memberId, config);

  return {
    id: m.id,
    state: m.state,
    clusterId: m.clusterId,
    trustScore: m.trustScore,
    suspendedUntil: m.suspendedUntil,
    needsTopup: m.needsTopup,
    openLoanCount: Number(counts.open),
    pendingLoanCount: Number(counts.pending),
    hasCompletedBorrow: m.firstBorrowCompletedAt !== null,
    activation: activation.ok
      ? { ok: true }
      : { ok: false, reason: activation.reason ?? "Finish activating your membership." },
  };
}

async function dropPointSnapshot(
  tx: Tx,
  id: string | null | undefined,
): Promise<DropPointSnapshot | null> {
  if (!id) return null;
  const [d] = await tx.select().from(dropPoints).where(eq(dropPoints.id, id)).for("update");
  return d
    ? {
        id: d.id,
        clusterId: d.clusterId,
        active: d.active,
        occupancy: d.occupancy,
        capacity: d.capacity,
      }
    : null;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e && typeof e === "object") {
    const rec = e as { code?: string; constraint?: string; message?: string; cause?: unknown };
    if (
      rec.code === "23505" ||
      rec.constraint === "loans_one_open_per_copy_uidx" ||
      rec.message?.includes("loans_one_open_per_copy_uidx")
    )
      return true;
    e = rec.cause;
  }
  return false;
}

/**
 * Creates a loan request: locks the copy row, builds the guard context, runs
 * the machine, inserts the loan (the partial unique index is the last line of
 * defence against a concurrent request), applies effects, writes the event.
 */
export async function createLoanRequest(
  db: Db,
  input: RequestInput,
  actor: Actor,
  config: AppConfig,
  deps: PersistDeps = {},
): Promise<PersistResult> {
  const now = deps.now?.() ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const copy = await lockCopy(tx, input.copyId);
      if (!copy) return { ok: false as const, error: loanError("copy_unavailable") };
      const borrower = await borrowerSnapshot(tx, input.borrowerId, config);
      if (!borrower) return { ok: false as const, error: loanError("borrower_not_active") };
      const dropPoint = await dropPointSnapshot(tx, input.dropPointId);

      const ctx: Ctx = {
        now,
        actor,
        config: machineConfig(config),
        copy,
        borrower,
        dropPoint,
        newId: deps.newId ?? randomUUID,
        newHandoffCode: deps.newHandoffCode ?? generateHandoffCode,
      };
      const res = requestLoan(input, ctx);
      if (!res.ok) return { ok: false as const, error: res.error };

      const [row] = await tx.insert(loans).values(loanToRow(res.value.loan)).returning();
      await applyEffects(tx, res.value.effects, config, now);
      await tx.insert(events).values({
        aggregate: "loan",
        aggregateId: row.id,
        type: res.value.eventType,
        actorId: actor.kind === "member" ? actor.memberId : null,
        payload: {
          copyId: copy.id,
          handoffMethod: input.handoffMethod,
          dropPointId: input.dropPointId ?? null,
        },
        createdAt: now,
      });
      return { ok: true as const, loan: row, eventType: res.value.eventType };
    });
  } catch (err) {
    if (isUniqueViolation(err))
      return {
        ok: false,
        error: loanError("copy_unavailable", "Someone else just requested this copy."),
      };
    throw err;
  }
}

/**
 * Applies one event to an existing loan. Locks the copy first (all loan
 * writes serialise on the copy), then the loan row, then runs the machine.
 * Idempotent for repeated confirmations: the machine returns already_confirmed,
 * which callers replaying an offline outbox may treat as success.
 */
export async function applyLoanEvent(
  db: Db,
  loanId: string,
  event: LoanEvent,
  actor: Actor,
  config: AppConfig,
  deps: PersistDeps = {},
): Promise<PersistResult> {
  const now = deps.now?.() ?? new Date();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ copyId: loans.copyId })
      .from(loans)
      .where(eq(loans.id, loanId));
    if (!existing)
      return { ok: false as const, error: loanError("invalid_transition", "Loan not found.") };
    const copy = await lockCopy(tx, existing.copyId);
    if (!copy)
      return { ok: false as const, error: loanError("invalid_transition", "Copy not found.") };
    const [row] = await tx.select().from(loans).where(eq(loans.id, loanId)).for("update");
    const loan = rowToLoan(row);

    // Borrower snapshot is only needed for request guards, but it is cheap enough to load always.
    const borrower = await borrowerSnapshot(tx, loan.borrowerId, config);
    const dropPoint = await dropPointSnapshot(tx, loan.dropPointId);

    const ctx: Ctx = {
      now,
      actor,
      config: machineConfig(config),
      copy,
      borrower: borrower ?? undefined,
      dropPoint,
      newId: deps.newId ?? randomUUID,
      newHandoffCode: deps.newHandoffCode ?? generateHandoffCode,
    };
    const res = transition(loan, event, ctx);
    if (!res.ok) return { ok: false as const, error: res.error };

    const [updated] = await tx
      .update(loans)
      .set(loanToRow(res.value.loan))
      .where(eq(loans.id, loanId))
      .returning();
    await applyEffects(tx, res.value.effects, config, now);
    await tx.insert(events).values({
      aggregate: "loan",
      aggregateId: loanId,
      type: res.value.eventType,
      actorId: actor.kind === "member" ? actor.memberId : null,
      payload: { event: event.type, from: loan.state, to: res.value.loan.state },
      createdAt: now,
    });
    return { ok: true as const, loan: updated, eventType: res.value.eventType };
  });
}

/** Loans due for a scheduled transition; the cron feeds each to applyLoanEvent. */
export async function findLoansInStates(db: Db, states: LoanRow["state"][]): Promise<LoanRow[]> {
  return db
    .select()
    .from(loans)
    .where(and(inArray(loans.state, states)));
}
