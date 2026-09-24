import type {
  Ctx,
  Effect,
  Loan,
  LoanError,
  LoanErrorCode,
  LoanEvent,
  Party,
  RequestInput,
  Result,
  Transition,
} from "./types";

/**
 * Loan state machine (design.md). Pure: no I/O, no Date.now(), no randomness.
 * Everything comes in through `ctx`; everything that must happen in the world
 * comes out as `effects` for the persistence layer to apply transactionally.
 *
 *   requestLoan(input, ctx)          -> Result<Transition>   (creates a loan in `requested`)
 *   transition(loan, event, ctx)     -> Result<Transition>   (every other move)
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const MESSAGES: Record<LoanErrorCode, string> = {
  invalid_transition: "That action isn't available for this loan right now.",
  not_a_party: "You're not part of this loan.",
  not_lender: "Only the lender can do that.",
  not_borrower: "Only the borrower can do that.",
  not_admin: "Only an admin can do that.",
  in_hand_required: "Confirm you have the book in hand before accepting.",
  already_confirmed: "You've already confirmed this.",
  photo_required: "Take a photo of the book to confirm.",
  code_required: "Enter the handoff code.",
  wrong_code: "That code doesn't match.",
  collect_before_drop: "The lender hasn't dropped the book off yet.",
  condition_required: "Select the book's condition.",
  already_extended: "This loan has already been extended once.",
  dispute_window_closed: "The 48-hour window to report a problem has passed.",
  too_early: "Not yet.",
  already_confirmed_by_both: "Both sides have already confirmed.",
  invalid_charge: "Charge must be between 0 and the replacement value.",
  own_copy: "You can't borrow your own book.",
  copy_unavailable: "This copy isn't available right now.",
  cluster_mismatch: "Only members of this area can borrow this copy.",
  handoff_not_allowed: "The lender doesn't offer that handoff method for this copy.",
  drop_point_required: "Choose a drop point.",
  drop_point_unavailable: "That drop point is full or closed. Choose another.",
  borrower_not_active: "Pick a plan and pay the deposit to start borrowing.",
  borrower_suspended: "Your account is suspended from borrowing for now.",
  trust_below_copy_min: "The lender has set a higher trust threshold for this copy.",
  trust_below_floor: "Your trust score is too low to borrow. Lend a few books to recover it.",
  deposit_topup_required: "Top up your deposit before requesting another book.",
  activation_required: "Finish activating your membership to borrow.",
  at_concurrent_limit: "You've reached your plan's limit for books at once.",
  new_borrower_one_at_a_time: "Until your first return, you can have one request open at a time.",
};

export function loanError(code: LoanErrorCode, message?: string): LoanError {
  return { code, message: message ?? MESSAGES[code] };
}

const fail = <T>(code: LoanErrorCode, message?: string): Result<T> => ({
  ok: false,
  error: loanError(code, message),
});
const succeed = (loan: Loan, effects: Effect[], eventType: string): Result<Transition> => ({
  ok: true,
  value: { loan, effects, eventType },
});

export function partyOf(loan: Loan, memberId: string): Party | null {
  if (memberId === loan.lenderId) return "lender";
  if (memberId === loan.borrowerId) return "borrower";
  return null;
}

function actorParty(loan: Loan, ctx: Ctx): Party | null {
  return ctx.actor.kind === "member" ? partyOf(loan, ctx.actor.memberId) : null;
}

const startOfMonthUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

export function requestLoan(input: RequestInput, ctx: Ctx): Result<Transition> {
  const { copy, borrower, config, now } = ctx;
  if (!borrower) return fail("borrower_not_active");
  if (ctx.actor.kind !== "member" || ctx.actor.memberId !== borrower.id)
    return fail("not_borrower");

  if (input.copyId !== copy.id) return fail("copy_unavailable");
  if (copy.ownerId === borrower.id) return fail("own_copy");
  if (copy.availability !== "available") return fail("copy_unavailable");
  if (!borrower.clusterId || borrower.clusterId !== copy.clusterId) return fail("cluster_mismatch");
  if (!copy.allowedHandoffs.includes(input.handoffMethod)) return fail("handoff_not_allowed");

  if (input.handoffMethod === "drop_point") {
    if (!input.dropPointId) return fail("drop_point_required");
    const dp = ctx.dropPoint;
    if (
      !dp ||
      dp.id !== input.dropPointId ||
      !dp.active ||
      dp.clusterId !== copy.clusterId ||
      dp.occupancy >= dp.capacity
    ) {
      return fail("drop_point_unavailable");
    }
  }

  if (borrower.state === "suspended" || (borrower.suspendedUntil && borrower.suspendedUntil > now))
    return fail("borrower_suspended");
  if (borrower.state !== "active" || !borrower.plan) return fail("borrower_not_active");
  if (copy.minBorrowerTrust > 0 && borrower.trustScore < copy.minBorrowerTrust)
    return fail("trust_below_copy_min");
  if (borrower.trustScore < config.min_trust_score) return fail("trust_below_floor");
  if (borrower.needsTopup) return fail("deposit_topup_required");
  if (!borrower.activation.ok) return fail("activation_required", borrower.activation.reason);
  if (borrower.openLoanCount >= borrower.plan.concurrentLimit) return fail("at_concurrent_limit");
  if (!borrower.hasCompletedBorrow && borrower.pendingLoanCount >= 1)
    return fail("new_borrower_one_at_a_time");

  const loan: Loan = {
    id: ctx.newId(),
    copyId: copy.id,
    bookId: copy.bookId,
    lenderId: copy.ownerId,
    borrowerId: borrower.id,
    state: "requested",
    handoffMethod: input.handoffMethod,
    dropPointId: input.handoffMethod === "drop_point" ? input.dropPointId! : null,
    handoffCode: null,
    requestedAt: now,
    respondedAt: null,
    outLenderConfirmedAt: null,
    outBorrowerConfirmedAt: null,
    handedOffAt: null,
    dueAt: null,
    extended: false,
    returnBorrowerConfirmedAt: null,
    returnLenderConfirmedAt: null,
    returnedAt: null,
    returnCondition: null,
    autoConfirmedSide: null,
    declineReason: null,
    poolMonth: null,
  };
  return succeed(
    loan,
    [
      { kind: "set_copy_availability", copyId: copy.id, availability: "requested" },
      {
        kind: "notify",
        memberId: loan.lenderId,
        template: "request_received",
        loanId: loan.id,
        vars: { handoff: input.handoffMethod },
      },
    ],
    "loan.requested",
  );
}

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

export function transition(loan: Loan, event: LoanEvent, ctx: Ctx): Result<Transition> {
  switch (loan.state) {
    case "requested":
      return fromRequested(loan, event, ctx);
    case "accepted":
      return fromAccepted(loan, event, ctx);
    case "on_loan":
      return fromOnLoan(loan, event, ctx);
    case "overdue":
      return fromOverdue(loan, event, ctx);
    case "returned":
      return fromReturned(loan, event, ctx);
    case "disputed":
      return fromDisputed(loan, event, ctx);
    case "declined":
    case "expired":
    case "lost":
    case "resolved":
      return fail("invalid_transition");
  }
}

function fromRequested(loan: Loan, event: LoanEvent, ctx: Ctx): Result<Transition> {
  const { now, copy, config } = ctx;
  switch (event.type) {
    case "accept": {
      if (actorParty(loan, ctx) !== "lender") return fail("not_lender");
      if (!event.inHandConfirmed) return fail("in_hand_required");
      const next: Loan = {
        ...loan,
        state: "accepted",
        respondedAt: now,
        handoffCode: loan.handoffMethod === "drop_point" ? ctx.newHandoffCode() : null,
      };
      return succeed(
        next,
        [
          {
            kind: "notify",
            memberId: loan.borrowerId,
            template: "request_accepted",
            loanId: loan.id,
            vars: { handoff: loan.handoffMethod },
          },
        ],
        "loan.accepted",
      );
    }
    case "decline": {
      if (actorParty(loan, ctx) !== "lender") return fail("not_lender");
      const next: Loan = {
        ...loan,
        state: "declined",
        respondedAt: now,
        declineReason: event.reason,
      };
      const effects: Effect[] = [];
      if (event.reason === "no_longer_have") {
        effects.push({ kind: "unlist_copy", copyId: copy.id, reason: "no_longer_have" });
      } else {
        effects.push(...declineOrExpire(ctx));
      }
      effects.push({
        kind: "notify",
        memberId: loan.borrowerId,
        template: "request_declined",
        loanId: loan.id,
        vars: { reason: event.reason },
      });
      return succeed(next, effects, "loan.declined");
    }
    case "timeout": {
      if (ctx.actor.kind !== "system") return fail("not_admin");
      if (now.getTime() - loan.requestedAt.getTime() < config.request_timeout_hours * HOUR)
        return fail("too_early");
      const next: Loan = { ...loan, state: "expired", respondedAt: now };
      return succeed(
        next,
        [
          ...declineOrExpire(ctx),
          {
            kind: "trust_event",
            memberId: loan.lenderId,
            trustKind: "request_ignored",
            loanId: loan.id,
          },
          {
            kind: "notify",
            memberId: loan.borrowerId,
            template: "request_expired",
            loanId: loan.id,
            vars: {},
          },
        ],
        "loan.expired",
      );
    }
    default:
      return fail("invalid_transition");
  }
}

/** Copy back to available, bump decline count, auto-unlist at the threshold (Requirement 5.8). */
function declineOrExpire(ctx: Ctx): Effect[] {
  const { copy, config } = ctx;
  const effects: Effect[] = [
    { kind: "set_copy_availability", copyId: copy.id, availability: "available" },
    { kind: "increment_decline_count", copyId: copy.id, by: 1 },
  ];
  if (copy.declineCount + 1 >= config.copy_decline_unlist_threshold) {
    effects.push({ kind: "unlist_copy", copyId: copy.id, reason: "decline_threshold" });
  }
  return effects;
}

function fromAccepted(loan: Loan, event: LoanEvent, ctx: Ctx): Result<Transition> {
  const { now, copy, config } = ctx;
  switch (event.type) {
    case "confirm_out": {
      const party = actorParty(loan, ctx);
      if (!party) return fail("not_a_party");
      const mine = party === "lender" ? loan.outLenderConfirmedAt : loan.outBorrowerConfirmedAt;
      if (mine) return fail("already_confirmed");

      const effects: Effect[] = [];
      if (loan.handoffMethod === "drop_point") {
        if (!event.code) return fail("code_required");
        if (event.code.trim().toUpperCase() !== loan.handoffCode) return fail("wrong_code");
        // Borrower collects only after the lender has dropped.
        if (party === "borrower" && !loan.outLenderConfirmedAt) return fail("collect_before_drop");
        if (loan.dropPointId)
          effects.push({
            kind: "drop_point_occupancy",
            dropPointId: loan.dropPointId,
            delta: party === "lender" ? 1 : -1,
          });
      } else {
        if (!event.photoPath) return fail("photo_required");
        effects.push({
          kind: "loan_photo",
          loanId: loan.id,
          takenBy: memberIdOf(loan, party),
          phase: "out",
          storagePath: event.photoPath,
        });
      }

      const next: Loan = {
        ...loan,
        outLenderConfirmedAt: party === "lender" ? now : loan.outLenderConfirmedAt,
        outBorrowerConfirmedAt: party === "borrower" ? now : loan.outBorrowerConfirmedAt,
      };
      if (next.outLenderConfirmedAt && next.outBorrowerConfirmedAt) {
        return succeed(...completeHandoff(next, ctx, effects, null));
      }
      const other = party === "lender" ? loan.borrowerId : loan.lenderId;
      effects.push({
        kind: "notify",
        memberId: other,
        template: "handoff_confirmed_one_side",
        loanId: loan.id,
        vars: { by: party },
      });
      return succeed(next, effects, "loan.handoff_confirmed");
    }
    case "auto_confirm_out": {
      if (ctx.actor.kind !== "system") return fail("not_admin");
      const confirmedAt = loan.outLenderConfirmedAt ?? loan.outBorrowerConfirmedAt;
      if (!confirmedAt) return fail("invalid_transition");
      if (loan.outLenderConfirmedAt && loan.outBorrowerConfirmedAt)
        return fail("already_confirmed_by_both");
      if (now.getTime() - confirmedAt.getTime() < config.handoff_auto_confirm_hours * HOUR)
        return fail("too_early");
      const confirmingSide: Party = loan.outLenderConfirmedAt ? "lender" : "borrower";
      const next: Loan = {
        ...loan,
        outLenderConfirmedAt: loan.outLenderConfirmedAt ?? now,
        outBorrowerConfirmedAt: loan.outBorrowerConfirmedAt ?? now,
      };
      const effects: Effect[] = [];
      // A drop-point collection assumed on the borrower's behalf still frees the shelf.
      if (loan.handoffMethod === "drop_point" && loan.dropPointId && confirmingSide === "lender") {
        effects.push({ kind: "drop_point_occupancy", dropPointId: loan.dropPointId, delta: -1 });
      }
      return succeed(...completeHandoff(next, ctx, effects, confirmingSide));
    }
    case "timeout": {
      if (ctx.actor.kind !== "system") return fail("not_admin");
      if (loan.outLenderConfirmedAt && loan.outBorrowerConfirmedAt)
        return fail("invalid_transition");
      const since = loan.respondedAt ?? loan.requestedAt;
      if (now.getTime() - since.getTime() < config.handoff_timeout_days * DAY)
        return fail("too_early");
      const next: Loan = { ...loan, state: "expired" };
      const effects: Effect[] = [
        { kind: "set_copy_availability", copyId: copy.id, availability: "available" },
      ];
      // No-show on whoever did not confirm (Requirement 6.6).
      if (!loan.outLenderConfirmedAt) {
        effects.push({
          kind: "trust_event",
          memberId: loan.lenderId,
          trustKind: "no_show",
          loanId: loan.id,
        });
        // An accepted-then-abandoned handoff counts heavily against the copy (Requirement 5.8).
        effects.push({ kind: "increment_decline_count", copyId: copy.id, by: 3 });
        effects.push({ kind: "unlist_copy", copyId: copy.id, reason: "lender_no_show" });
        // A lender who dropped at a drop point and the borrower never collected: shelf is still occupied; admin alert handles it.
      }
      if (!loan.outBorrowerConfirmedAt) {
        effects.push({
          kind: "trust_event",
          memberId: loan.borrowerId,
          trustKind: "no_show",
          loanId: loan.id,
        });
      }
      effects.push(
        {
          kind: "notify",
          memberId: loan.borrowerId,
          template: "handoff_expired",
          loanId: loan.id,
          vars: {},
        },
        {
          kind: "notify",
          memberId: loan.lenderId,
          template: "handoff_expired",
          loanId: loan.id,
          vars: {},
        },
      );
      return succeed(next, effects, "loan.handoff_expired");
    }
    default:
      return fail("invalid_transition");
  }
}

function completeHandoff(
  next: Loan,
  ctx: Ctx,
  effects: Effect[],
  autoSide: Party | null,
): [Loan, Effect[], string] {
  const periodDays = ctx.borrower?.plan?.loanPeriodDays ?? 21;
  const handedOffAt = ctx.now;
  const loan: Loan = {
    ...next,
    state: "on_loan",
    handedOffAt,
    dueAt: new Date(handedOffAt.getTime() + periodDays * DAY),
    autoConfirmedSide: autoSide,
  };
  effects.push(
    { kind: "set_copy_availability", copyId: loan.copyId, availability: "on_loan" },
    {
      kind: "notify",
      memberId: loan.borrowerId,
      template: autoSide ? "handoff_auto_confirmed" : "on_loan",
      loanId: loan.id,
      vars: { dueAt: loan.dueAt!.toISOString() },
    },
    {
      kind: "notify",
      memberId: loan.lenderId,
      template: autoSide ? "handoff_auto_confirmed" : "on_loan",
      loanId: loan.id,
      vars: { dueAt: loan.dueAt!.toISOString() },
    },
  );
  return [loan, effects, "loan.on_loan"];
}

function fromOnLoan(loan: Loan, event: LoanEvent, ctx: Ctx): Result<Transition> {
  const { now, config } = ctx;
  switch (event.type) {
    case "extend": {
      if (actorParty(loan, ctx) !== "borrower") return fail("not_borrower");
      if (loan.extended) return fail("already_extended");
      const next: Loan = {
        ...loan,
        extended: true,
        dueAt: new Date(loan.dueAt!.getTime() + config.extension_days * DAY),
      };
      return succeed(
        next,
        [
          {
            kind: "notify",
            memberId: loan.lenderId,
            template: "extended",
            loanId: loan.id,
            vars: { dueAt: next.dueAt!.toISOString() },
          },
        ],
        "loan.extended",
      );
    }
    case "overdue_tick": {
      if (ctx.actor.kind !== "system") return fail("not_admin");
      if (!loan.dueAt || now <= loan.dueAt) return fail("too_early");
      const next: Loan = { ...loan, state: "overdue" };
      return succeed(
        next,
        [
          {
            kind: "notify",
            memberId: loan.borrowerId,
            template: "overdue",
            loanId: loan.id,
            vars: {},
          },
          {
            kind: "notify",
            memberId: loan.lenderId,
            template: "overdue",
            loanId: loan.id,
            vars: {},
          },
        ],
        "loan.overdue",
      );
    }
    case "confirm_return":
      return confirmReturn(loan, event, ctx);
    case "auto_confirm_return":
      return autoConfirmReturn(loan, ctx);
    default:
      return fail("invalid_transition");
  }
}

function fromOverdue(loan: Loan, event: LoanEvent, ctx: Ctx): Result<Transition> {
  const { now, copy, config } = ctx;
  switch (event.type) {
    case "confirm_return":
      return confirmReturn(loan, event, ctx);
    case "auto_confirm_return":
      return autoConfirmReturn(loan, ctx);
    case "lost_tick": {
      if (ctx.actor.kind !== "system") return fail("not_admin");
      if (!loan.dueAt || now.getTime() - loan.dueAt.getTime() < config.overdue_to_lost_days * DAY)
        return fail("too_early");
      const next: Loan = { ...loan, state: "lost" };
      const until = new Date(now.getTime() + config.lost_suspension_days * DAY);
      return succeed(
        next,
        [
          { kind: "set_copy_availability", copyId: copy.id, availability: "lost" },
          {
            kind: "ledger",
            memberId: loan.borrowerId,
            account: "deposit",
            ledgerKind: "deposit_charge",
            amountPaise: -copy.replacementValuePaise,
            loanId: loan.id,
            note: "Book marked lost",
          },
          {
            kind: "ledger",
            memberId: loan.lenderId,
            account: "payout",
            ledgerKind: "lost_book_credit",
            amountPaise: copy.replacementValuePaise,
            loanId: loan.id,
            note: "Replacement for lost book",
          },
          { kind: "suspend_member", memberId: loan.borrowerId, until },
          {
            kind: "trust_event",
            memberId: loan.borrowerId,
            trustKind: "book_lost",
            loanId: loan.id,
          },
          {
            kind: "notify",
            memberId: loan.borrowerId,
            template: "book_lost",
            loanId: loan.id,
            vars: { amountPaise: copy.replacementValuePaise },
          },
          {
            kind: "notify",
            memberId: loan.lenderId,
            template: "book_lost",
            loanId: loan.id,
            vars: { amountPaise: copy.replacementValuePaise },
          },
        ],
        "loan.lost",
      );
    }
    default:
      return fail("invalid_transition");
  }
}

function confirmReturn(
  loan: Loan,
  event: Extract<LoanEvent, { type: "confirm_return" }>,
  ctx: Ctx,
): Result<Transition> {
  const { now } = ctx;
  const party = actorParty(loan, ctx);
  if (!party) return fail("not_a_party");
  const mine = party === "lender" ? loan.returnLenderConfirmedAt : loan.returnBorrowerConfirmedAt;
  if (mine) return fail("already_confirmed");

  const effects: Effect[] = [];
  if (loan.handoffMethod === "drop_point") {
    if (!event.code) return fail("code_required");
    if (event.code.trim().toUpperCase() !== loan.handoffCode) return fail("wrong_code");
    // Return is the mirror: borrower drops, lender collects.
    if (party === "lender" && !loan.returnBorrowerConfirmedAt) return fail("collect_before_drop");
    if (loan.dropPointId)
      effects.push({
        kind: "drop_point_occupancy",
        dropPointId: loan.dropPointId,
        delta: party === "borrower" ? 1 : -1,
      });
  } else if (!event.photoPath) {
    return fail("photo_required");
  }
  // The lender always records the condition on receipt (Requirement 8.2).
  if (party === "lender" && !event.condition) return fail("condition_required");
  if (event.photoPath) {
    effects.push({
      kind: "loan_photo",
      loanId: loan.id,
      takenBy: memberIdOf(loan, party),
      phase: "return",
      storagePath: event.photoPath,
      condition: party === "lender" ? event.condition : undefined,
    });
  }

  const next: Loan = {
    ...loan,
    returnLenderConfirmedAt: party === "lender" ? now : loan.returnLenderConfirmedAt,
    returnBorrowerConfirmedAt: party === "borrower" ? now : loan.returnBorrowerConfirmedAt,
    returnCondition: party === "lender" ? event.condition! : loan.returnCondition,
  };
  if (next.returnLenderConfirmedAt && next.returnBorrowerConfirmedAt) {
    return succeed(...completeReturn(next, ctx, effects, null));
  }
  const other = party === "lender" ? loan.borrowerId : loan.lenderId;
  effects.push({
    kind: "notify",
    memberId: other,
    template: "return_confirmed_one_side",
    loanId: loan.id,
    vars: { by: party },
  });
  return succeed(next, effects, "loan.return_confirmed");
}

function autoConfirmReturn(loan: Loan, ctx: Ctx): Result<Transition> {
  const { now, config } = ctx;
  if (ctx.actor.kind !== "system") return fail("not_admin");
  const confirmedAt = loan.returnLenderConfirmedAt ?? loan.returnBorrowerConfirmedAt;
  if (!confirmedAt) return fail("invalid_transition");
  if (loan.returnLenderConfirmedAt && loan.returnBorrowerConfirmedAt)
    return fail("already_confirmed_by_both");
  if (now.getTime() - confirmedAt.getTime() < config.handoff_auto_confirm_hours * HOUR)
    return fail("too_early");
  const confirmingSide: Party = loan.returnLenderConfirmedAt ? "lender" : "borrower";
  const next: Loan = {
    ...loan,
    returnLenderConfirmedAt: loan.returnLenderConfirmedAt ?? now,
    returnBorrowerConfirmedAt: loan.returnBorrowerConfirmedAt ?? now,
    // Lender never confirmed, so no condition was recorded; assume unchanged.
    returnCondition: loan.returnCondition ?? "good",
  };
  const effects: Effect[] = [];
  if (loan.handoffMethod === "drop_point" && loan.dropPointId && confirmingSide === "borrower") {
    effects.push({ kind: "drop_point_occupancy", dropPointId: loan.dropPointId, delta: -1 });
  }
  return succeed(...completeReturn(next, ctx, effects, confirmingSide));
}

function completeReturn(
  next: Loan,
  ctx: Ctx,
  effects: Effect[],
  autoSide: Party | null,
): [Loan, Effect[], string] {
  const { now, copy } = ctx;
  const loan: Loan = {
    ...next,
    state: "returned",
    returnedAt: now,
    poolMonth: startOfMonthUtc(now),
    autoConfirmedSide: autoSide ?? next.autoConfirmedSide,
  };
  const late = loan.dueAt ? now > loan.dueAt : false;
  effects.push(
    { kind: "set_copy_availability", copyId: copy.id, availability: "available" },
    { kind: "reset_decline_count", copyId: copy.id },
  );
  if (copy.verificationStatus === "unverified")
    effects.push({ kind: "verify_copy", copyId: copy.id });
  effects.push(
    {
      kind: "trust_event",
      memberId: loan.borrowerId,
      trustKind: late ? "return_late" : "return_on_time",
      loanId: loan.id,
    },
    {
      kind: "trust_event",
      memberId: loan.borrowerId,
      trustKind: "borrow_completed",
      loanId: loan.id,
    },
    { kind: "trust_event", memberId: loan.lenderId, trustKind: "lend_completed", loanId: loan.id },
    { kind: "set_first_borrow_completed", memberId: loan.borrowerId, at: now },
    {
      kind: "notify",
      memberId: loan.borrowerId,
      template: autoSide ? "return_auto_confirmed" : "returned",
      loanId: loan.id,
      vars: {},
    },
    {
      kind: "notify",
      memberId: loan.lenderId,
      template: autoSide ? "return_auto_confirmed" : "returned",
      loanId: loan.id,
      vars: {},
    },
  );
  return [loan, effects, "loan.returned"];
}

function fromReturned(loan: Loan, event: LoanEvent, ctx: Ctx): Result<Transition> {
  const { now, config } = ctx;
  if (event.type !== "dispute") return fail("invalid_transition");
  const party = actorParty(loan, ctx);
  if (!party) return fail("not_a_party");
  if (
    !loan.returnedAt ||
    now.getTime() - loan.returnedAt.getTime() > config.dispute_window_hours * HOUR
  )
    return fail("dispute_window_closed");
  const next: Loan = { ...loan, state: "disputed" };
  const openedBy = memberIdOf(loan, party);
  const other = party === "lender" ? loan.borrowerId : loan.lenderId;
  return succeed(
    next,
    [
      { kind: "create_dispute", loanId: loan.id, openedBy, reason: event.reason },
      { kind: "notify", memberId: other, template: "dispute_opened", loanId: loan.id, vars: {} },
      {
        kind: "notify_admins",
        template: "dispute_opened",
        loanId: loan.id,
        vars: { openedBy: party },
      },
    ],
    "loan.disputed",
  );
}

function fromDisputed(loan: Loan, event: LoanEvent, ctx: Ctx): Result<Transition> {
  const { copy } = ctx;
  if (event.type !== "resolve") return fail("invalid_transition");
  if (ctx.actor.kind !== "member" || !ctx.actor.isAdmin) return fail("not_admin");

  let charge = 0;
  if (event.resolution === "full_charge") charge = copy.replacementValuePaise;
  else if (event.resolution === "partial_charge") {
    charge = event.chargePaise ?? -1;
    if (!Number.isInteger(charge) || charge <= 0 || charge > copy.replacementValuePaise)
      return fail("invalid_charge");
  }

  const next: Loan = { ...loan, state: "resolved" };
  const effects: Effect[] = [
    {
      kind: "resolve_dispute",
      loanId: loan.id,
      resolution: event.resolution,
      chargePaise: charge,
      note: event.note,
      resolvedBy: ctx.actor.memberId,
    },
  ];
  if (charge > 0) {
    effects.push(
      {
        kind: "ledger",
        memberId: loan.borrowerId,
        account: "deposit",
        ledgerKind: "deposit_charge",
        amountPaise: -charge,
        loanId: loan.id,
        note: `Dispute resolved: ${event.resolution}`,
      },
      {
        kind: "ledger",
        memberId: loan.lenderId,
        account: "payout",
        ledgerKind: "lost_book_credit",
        amountPaise: charge,
        loanId: loan.id,
        note: `Dispute resolved: ${event.resolution}`,
      },
      {
        kind: "trust_event",
        memberId: loan.borrowerId,
        trustKind: "dispute_lost",
        loanId: loan.id,
      },
    );
  }
  // A dismissed dispute costs the opener nothing in the MVP; repeated frivolous disputes are an admin matter.
  effects.push(
    {
      kind: "notify",
      memberId: loan.borrowerId,
      template: "dispute_resolved",
      loanId: loan.id,
      vars: { resolution: event.resolution, chargePaise: charge },
    },
    {
      kind: "notify",
      memberId: loan.lenderId,
      template: "dispute_resolved",
      loanId: loan.id,
      vars: { resolution: event.resolution, chargePaise: charge },
    },
  );
  return succeed(next, effects, "loan.resolved");
}

function memberIdOf(loan: Loan, party: Party): string {
  return party === "lender" ? loan.lenderId : loan.borrowerId;
}
