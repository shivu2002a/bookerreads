import { describe, expect, it } from "vitest";
import { requestLoan, transition } from "./machine";
import {
  LOAN_EVENT_TYPES,
  LOAN_STATES,
  type BorrowerSnapshot,
  type CopySnapshot,
  type Ctx,
  type Effect,
  type Loan,
  type LoanEvent,
  type LoanEventType,
  type LoanState,
  type MachineConfig,
} from "./types";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-21T10:00:00Z");
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

const LENDER = "lender-1";
const BORROWER = "borrower-1";
const OUTSIDER = "someone-else";
const ADMIN = "admin-1";
const CODE = "ABC234";

const config: MachineConfig = {
  request_timeout_hours: 48,
  handoff_timeout_days: 5,
  handoff_auto_confirm_hours: 72,
  extension_days: 7,
  overdue_to_lost_days: 14,
  dispute_window_hours: 48,
  lost_suspension_days: 90,
  copy_decline_unlist_threshold: 3,
  min_trust_score: 30,
};

const copy: CopySnapshot = {
  id: "copy-1",
  bookId: "book-1",
  ownerId: LENDER,
  clusterId: "cluster-1",
  availability: "available",
  minBorrowerTrust: 0,
  allowedHandoffs: ["meetup", "drop_point"],
  declineCount: 0,
  verificationStatus: "unverified",
  replacementValuePaise: 49900,
};

const borrower: BorrowerSnapshot = {
  id: BORROWER,
  state: "active",
  clusterId: "cluster-1",
  trustScore: 60,
  suspendedUntil: null,
  needsTopup: false,
  plan: { concurrentLimit: 2, loanPeriodDays: 21 },
  openLoanCount: 0,
  pendingLoanCount: 0,
  hasCompletedBorrow: true,
  activation: { ok: true },
};

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    now: NOW,
    actor: { kind: "member", memberId: BORROWER, isAdmin: false },
    config,
    copy,
    borrower,
    dropPoint: { id: "dp-1", clusterId: "cluster-1", active: true, occupancy: 3, capacity: 20 },
    newId: () => "loan-1",
    newHandoffCode: () => CODE,
    ...over,
  };
}
const asLender = (over: Partial<Ctx> = {}) =>
  ctx({ actor: { kind: "member", memberId: LENDER, isAdmin: false }, ...over });
const asBorrower = (over: Partial<Ctx> = {}) =>
  ctx({ actor: { kind: "member", memberId: BORROWER, isAdmin: false }, ...over });
const asOutsider = (over: Partial<Ctx> = {}) =>
  ctx({ actor: { kind: "member", memberId: OUTSIDER, isAdmin: false }, ...over });
const asAdmin = (over: Partial<Ctx> = {}) =>
  ctx({ actor: { kind: "member", memberId: ADMIN, isAdmin: true }, ...over });
const asSystem = (over: Partial<Ctx> = {}) => ctx({ actor: { kind: "system" }, ...over });

/** A loan in the given state with plausible, time-consistent timestamps relative to NOW. */
function loanIn(state: LoanState, over: Partial<Loan> = {}): Loan {
  const base: Loan = {
    id: "loan-1",
    copyId: copy.id,
    bookId: copy.bookId,
    lenderId: LENDER,
    borrowerId: BORROWER,
    state,
    handoffMethod: "meetup",
    dropPointId: null,
    handoffCode: null,
    requestedAt: ago(3 * D),
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
  const at = (s: LoanState): Partial<Loan> => {
    switch (s) {
      case "requested":
        return { requestedAt: ago(1 * H) };
      case "declined":
        return { respondedAt: ago(2 * D), declineReason: "not_available" };
      case "expired":
        return { respondedAt: ago(1 * D) };
      case "accepted":
        return { respondedAt: ago(1 * D) };
      case "on_loan":
        return {
          respondedAt: ago(10 * D),
          outLenderConfirmedAt: ago(9 * D),
          outBorrowerConfirmedAt: ago(9 * D),
          handedOffAt: ago(9 * D),
          dueAt: ahead(12 * D),
        };
      case "overdue":
        return {
          respondedAt: ago(30 * D),
          outLenderConfirmedAt: ago(29 * D),
          outBorrowerConfirmedAt: ago(29 * D),
          handedOffAt: ago(29 * D),
          dueAt: ago(8 * D),
        };
      case "returned":
      case "disputed":
      case "resolved":
        return {
          respondedAt: ago(20 * D),
          outLenderConfirmedAt: ago(19 * D),
          outBorrowerConfirmedAt: ago(19 * D),
          handedOffAt: ago(19 * D),
          dueAt: ahead(2 * D),
          returnBorrowerConfirmedAt: ago(1 * H),
          returnLenderConfirmedAt: ago(1 * H),
          returnedAt: ago(1 * H),
          returnCondition: "good",
          poolMonth: new Date("2026-09-01"),
        };
      case "lost":
        return { respondedAt: ago(40 * D), handedOffAt: ago(39 * D), dueAt: ago(18 * D) };
    }
  };
  return { ...base, ...at(state), ...over };
}

/** A well-formed instance of each event, as the right actor, so the table test exercises the happy guard path. */
function eventFor(type: LoanEventType): { event: LoanEvent; ctx: Ctx } {
  switch (type) {
    case "accept":
      return { event: { type, inHandConfirmed: true }, ctx: asLender() };
    case "decline":
      return { event: { type, reason: "not_available" }, ctx: asLender() };
    case "timeout":
      return { event: { type }, ctx: asSystem({ now: ahead(10 * D) }) };
    case "confirm_out":
      return { event: { type, photoPath: "loans/x/out.jpg" }, ctx: asLender() };
    case "auto_confirm_out":
      return { event: { type }, ctx: asSystem({ now: ahead(10 * D) }) };
    case "extend":
      return { event: { type }, ctx: asBorrower() };
    case "overdue_tick":
      return { event: { type }, ctx: asSystem({ now: ahead(30 * D) }) };
    case "confirm_return":
      return { event: { type, photoPath: "loans/x/ret.jpg", condition: "good" }, ctx: asLender() };
    case "auto_confirm_return":
      return { event: { type }, ctx: asSystem({ now: ahead(10 * D) }) };
    case "lost_tick":
      return { event: { type }, ctx: asSystem({ now: ahead(30 * D) }) };
    case "dispute":
      return { event: { type, reason: "Pages torn out of the middle section." }, ctx: asLender() };
    case "resolve":
      return {
        event: { type, resolution: "dismissed", note: "No new damage visible." },
        ctx: asAdmin(),
      };
  }
}

/** The design.md transition table: which (state, event) pairs are legal at all. */
const LEGAL: Record<LoanState, LoanEventType[]> = {
  requested: ["accept", "decline", "timeout"],
  accepted: ["confirm_out", "auto_confirm_out", "timeout"],
  on_loan: ["extend", "overdue_tick", "confirm_return", "auto_confirm_return"],
  overdue: ["confirm_return", "auto_confirm_return", "lost_tick"],
  returned: ["dispute"],
  disputed: ["resolve"],
  declined: [],
  expired: [],
  lost: [],
  resolved: [],
};

/** Extra loan shape some legal pairs need (one-sided confirmations for the auto events). */
function shapeFor(state: LoanState, type: LoanEventType): Partial<Loan> {
  if (state === "accepted" && type === "auto_confirm_out")
    return { outLenderConfirmedAt: ago(4 * D) };
  if ((state === "on_loan" || state === "overdue") && type === "auto_confirm_return")
    return { returnBorrowerConfirmedAt: ago(4 * D) };
  if (state === "on_loan" && type === "confirm_return") return {};
  return {};
}

const kinds = (effects: Effect[]) => effects.map((e) => e.kind);
const find = <K extends Effect["kind"]>(effects: Effect[], kind: K) =>
  effects.filter((e): e is Extract<Effect, { kind: K }> => e.kind === kind);

// ---------------------------------------------------------------------------
// exhaustive state x event table
// ---------------------------------------------------------------------------

describe("transition table: every state x every event", () => {
  for (const state of LOAN_STATES) {
    for (const type of LOAN_EVENT_TYPES) {
      const legal = LEGAL[state].includes(type);
      it(`${state} + ${type} -> ${legal ? "transition" : "invalid_transition"}`, () => {
        const { event, ctx: c } = eventFor(type);
        const res = transition(loanIn(state, shapeFor(state, type)), event, c);
        if (legal) {
          expect(res.ok, res.ok ? "" : res.error.message).toBe(true);
        } else {
          expect(res.ok).toBe(false);
          if (!res.ok) expect(res.error.code).toBe("invalid_transition");
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

describe("requestLoan guards", () => {
  const input = { copyId: copy.id, borrowerId: BORROWER, handoffMethod: "meetup" as const };

  it("creates a requested loan, marks the copy requested, and notifies the lender", () => {
    const res = requestLoan(input, asBorrower());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.loan).toMatchObject({
      id: "loan-1",
      state: "requested",
      lenderId: LENDER,
      borrowerId: BORROWER,
      requestedAt: NOW,
      handoffCode: null,
    });
    expect(kinds(res.value.effects)).toEqual(["set_copy_availability", "notify"]);
    expect(find(res.value.effects, "set_copy_availability")[0].availability).toBe("requested");
    expect(find(res.value.effects, "notify")[0]).toMatchObject({
      memberId: LENDER,
      template: "request_received",
    });
  });

  it.each([
    ["own_copy", { copy: { ...copy, ownerId: BORROWER } }],
    ["copy_unavailable", { copy: { ...copy, availability: "requested" as const } }],
    ["cluster_mismatch", { borrower: { ...borrower, clusterId: "cluster-2" } }],
    ["handoff_not_allowed", { copy: { ...copy, allowedHandoffs: ["drop_point" as const] } }],
    ["borrower_suspended", { borrower: { ...borrower, state: "suspended" as const } }],
    ["borrower_suspended", { borrower: { ...borrower, suspendedUntil: ahead(1 * D) } }],
    [
      "borrower_not_active",
      { borrower: { ...borrower, state: "registered" as const, plan: null } },
    ],
    ["borrower_not_active", { borrower: { ...borrower, state: "lapsed" as const } }],
    [
      "trust_below_copy_min",
      { borrower: { ...borrower, trustScore: 45 }, copy: { ...copy, minBorrowerTrust: 50 } },
    ],
    ["trust_below_floor", { borrower: { ...borrower, trustScore: 29 } }],
    ["deposit_topup_required", { borrower: { ...borrower, needsTopup: true } }],
    [
      "activation_required",
      {
        borrower: {
          ...borrower,
          activation: { ok: false as const, reason: "List 3 books first." },
        },
      },
    ],
    ["at_concurrent_limit", { borrower: { ...borrower, openLoanCount: 2 } }],
    [
      "new_borrower_one_at_a_time",
      { borrower: { ...borrower, hasCompletedBorrow: false, pendingLoanCount: 1 } },
    ],
  ] as Array<[string, Partial<Ctx>]>)("refuses with %s", (code, over) => {
    const res = requestLoan(input, asBorrower(over));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(code);
  });

  it("a new borrower with no pending request may request", () => {
    expect(
      requestLoan(
        input,
        asBorrower({ borrower: { ...borrower, hasCompletedBorrow: false, pendingLoanCount: 0 } }),
      ).ok,
    ).toBe(true);
  });

  it("only the borrower themselves can request on their behalf", () => {
    const res = requestLoan(input, asOutsider());
    expect(!res.ok && res.error.code).toBe("not_borrower");
  });

  it("drop-point requests need an available drop point in the cluster", () => {
    const dp = { type: "drop_point" as const };
    expect(requestLoan({ ...input, handoffMethod: "drop_point" }, asBorrower()).ok).toBe(false); // no dropPointId
    const full = requestLoan(
      { ...input, handoffMethod: "drop_point", dropPointId: "dp-1" },
      asBorrower({
        dropPoint: {
          id: "dp-1",
          clusterId: "cluster-1",
          active: true,
          occupancy: 20,
          capacity: 20,
        },
      }),
    );
    expect(!full.ok && full.error.code).toBe("drop_point_unavailable");
    const ok = requestLoan(
      { ...input, handoffMethod: "drop_point", dropPointId: "dp-1" },
      asBorrower(),
    );
    expect(ok.ok && ok.value.loan.dropPointId).toBe("dp-1");
    void dp;
  });
});

// ---------------------------------------------------------------------------
// requested
// ---------------------------------------------------------------------------

describe("requested", () => {
  it("accept needs the lender and the in-hand confirmation; drop-point accept assigns a code", () => {
    const r = loanIn("requested");
    expect(transition(r, { type: "accept", inHandConfirmed: true }, asBorrower())).toMatchObject({
      ok: false,
      error: { code: "not_lender" },
    });
    expect(transition(r, { type: "accept", inHandConfirmed: false }, asLender())).toMatchObject({
      ok: false,
      error: { code: "in_hand_required" },
    });
    const meet = transition(r, { type: "accept", inHandConfirmed: true }, asLender());
    expect(meet.ok && meet.value.loan).toMatchObject({
      state: "accepted",
      respondedAt: NOW,
      handoffCode: null,
    });
    const drop = transition(
      loanIn("requested", { handoffMethod: "drop_point", dropPointId: "dp-1" }),
      { type: "accept", inHandConfirmed: true },
      asLender(),
    );
    expect(drop.ok && drop.value.loan.handoffCode).toBe(CODE);
    expect(meet.ok && find(meet.value.effects, "notify")[0]).toMatchObject({
      memberId: BORROWER,
      template: "request_accepted",
    });
  });

  it("decline frees the copy and counts against it; no_longer_have unlists instead", () => {
    const d = transition(
      loanIn("requested"),
      { type: "decline", reason: "not_available" },
      asLender(),
    );
    expect(d.ok && d.value.loan.state).toBe("declined");
    expect(d.ok && kinds(d.value.effects)).toEqual([
      "set_copy_availability",
      "increment_decline_count",
      "notify",
    ]);

    const gone = transition(
      loanIn("requested"),
      { type: "decline", reason: "no_longer_have" },
      asLender(),
    );
    expect(gone.ok && kinds(gone.value.effects)).toEqual(["unlist_copy", "notify"]);
    expect(gone.ok && find(gone.value.effects, "unlist_copy")[0].reason).toBe("no_longer_have");
  });

  it("the third decline or expiry auto-unlists the copy", () => {
    const d = transition(
      loanIn("requested"),
      { type: "decline", reason: "other" },
      asLender({ copy: { ...copy, declineCount: 2 } }),
    );
    expect(d.ok && find(d.value.effects, "unlist_copy")[0]?.reason).toBe("decline_threshold");
    const two = transition(
      loanIn("requested"),
      { type: "decline", reason: "other" },
      asLender({ copy: { ...copy, declineCount: 1 } }),
    );
    expect(two.ok && find(two.value.effects, "unlist_copy")).toHaveLength(0);
  });

  it("timeout only after 48 h, only by the system, and records request_ignored on the lender", () => {
    const r = loanIn("requested", { requestedAt: ago(47 * H) });
    expect(transition(r, { type: "timeout" }, asSystem())).toMatchObject({
      ok: false,
      error: { code: "too_early" },
    });
    expect(
      transition(
        loanIn("requested", { requestedAt: ago(49 * H) }),
        { type: "timeout" },
        asLender(),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_admin" } });
    const t = transition(
      loanIn("requested", { requestedAt: ago(49 * H) }),
      { type: "timeout" },
      asSystem(),
    );
    expect(t.ok && t.value.loan.state).toBe("expired");
    expect(t.ok && find(t.value.effects, "trust_event")).toEqual([
      { kind: "trust_event", memberId: LENDER, trustKind: "request_ignored", loanId: "loan-1" },
    ]);
    expect(t.ok && find(t.value.effects, "notify")[0]).toMatchObject({
      memberId: BORROWER,
      template: "request_expired",
    });
  });
});

// ---------------------------------------------------------------------------
// accepted: handoff out
// ---------------------------------------------------------------------------

describe("accepted (meet-up)", () => {
  it("each party confirms once with a photo; the second confirmation starts the loan", () => {
    const a = loanIn("accepted");
    expect(transition(a, { type: "confirm_out" }, asLender())).toMatchObject({
      ok: false,
      error: { code: "photo_required" },
    });
    expect(transition(a, { type: "confirm_out", photoPath: "p" }, asOutsider())).toMatchObject({
      ok: false,
      error: { code: "not_a_party" },
    });

    const first = transition(a, { type: "confirm_out", photoPath: "out-l.jpg" }, asLender());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.loan.state).toBe("accepted");
    expect(first.value.loan.outLenderConfirmedAt).toEqual(NOW);
    expect(kinds(first.value.effects)).toEqual(["loan_photo", "notify"]);
    expect(find(first.value.effects, "notify")[0]).toMatchObject({
      memberId: BORROWER,
      template: "handoff_confirmed_one_side",
    });

    expect(
      transition(first.value.loan, { type: "confirm_out", photoPath: "again.jpg" }, asLender()),
    ).toMatchObject({ ok: false, error: { code: "already_confirmed" } });

    const second = transition(
      first.value.loan,
      { type: "confirm_out", photoPath: "out-b.jpg" },
      asBorrower(),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.loan.state).toBe("on_loan");
    expect(second.value.loan.handedOffAt).toEqual(NOW);
    expect(second.value.loan.dueAt).toEqual(ahead(21 * D));
    expect(second.value.loan.autoConfirmedSide).toBeNull();
    expect(find(second.value.effects, "set_copy_availability")[0].availability).toBe("on_loan");
    expect(find(second.value.effects, "notify").map((n) => n.template)).toEqual([
      "on_loan",
      "on_loan",
    ]);
  });

  it("due date follows the borrower's plan period", () => {
    const a = loanIn("accepted", { outLenderConfirmedAt: ago(1 * H) });
    const res = transition(
      a,
      { type: "confirm_out", photoPath: "b.jpg" },
      asBorrower({ borrower: { ...borrower, plan: { concurrentLimit: 3, loanPeriodDays: 28 } } }),
    );
    expect(res.ok && res.value.loan.dueAt).toEqual(ahead(28 * D));
  });

  it("auto-confirms in favour of the confirming side after 72 h", () => {
    const oneSided = loanIn("accepted", { outLenderConfirmedAt: ago(71 * H) });
    expect(transition(oneSided, { type: "auto_confirm_out" }, asSystem())).toMatchObject({
      ok: false,
      error: { code: "too_early" },
    });
    const res = transition(
      loanIn("accepted", { outLenderConfirmedAt: ago(73 * H) }),
      { type: "auto_confirm_out" },
      asSystem(),
    );
    expect(res.ok && res.value.loan).toMatchObject({
      state: "on_loan",
      autoConfirmedSide: "lender",
    });
    expect(res.ok && find(res.value.effects, "notify").map((n) => n.template)).toEqual([
      "handoff_auto_confirmed",
      "handoff_auto_confirmed",
    ]);
    expect(transition(loanIn("accepted"), { type: "auto_confirm_out" }, asSystem())).toMatchObject({
      ok: false,
      error: { code: "invalid_transition" },
    });
  });

  it("times out after 5 days with no-shows on whoever did not confirm", () => {
    expect(
      transition(loanIn("accepted", { respondedAt: ago(4 * D) }), { type: "timeout" }, asSystem()),
    ).toMatchObject({ ok: false, error: { code: "too_early" } });

    const neither = transition(
      loanIn("accepted", { respondedAt: ago(6 * D) }),
      { type: "timeout" },
      asSystem(),
    );
    expect(neither.ok && neither.value.loan.state).toBe("expired");
    expect(
      neither.ok &&
        find(neither.value.effects, "trust_event")
          .map((t) => t.memberId)
          .sort(),
    ).toEqual([BORROWER, LENDER].sort());
    expect(neither.ok && find(neither.value.effects, "increment_decline_count")[0]?.by).toBe(3);
    expect(neither.ok && find(neither.value.effects, "unlist_copy")[0]?.reason).toBe(
      "lender_no_show",
    );

    const lenderShowed = transition(
      loanIn("accepted", { respondedAt: ago(6 * D), outLenderConfirmedAt: ago(5 * D) }),
      { type: "timeout" },
      asSystem(),
    );
    expect(lenderShowed.ok && find(lenderShowed.value.effects, "trust_event")).toEqual([
      { kind: "trust_event", memberId: BORROWER, trustKind: "no_show", loanId: "loan-1" },
    ]);
    expect(lenderShowed.ok && find(lenderShowed.value.effects, "unlist_copy")).toHaveLength(0);
    expect(
      lenderShowed.ok && find(lenderShowed.value.effects, "set_copy_availability")[0].availability,
    ).toBe("available");
  });
});

describe("accepted (Porter / courier)", () => {
  it("is requested without a drop point and accepted without a code", () => {
    const req = requestLoan(
      { copyId: copy.id, borrowerId: BORROWER, handoffMethod: "courier" },
      asBorrower({ copy: { ...copy, allowedHandoffs: ["courier"] } }),
    );
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    expect(req.value.loan).toMatchObject({ handoffMethod: "courier", dropPointId: null });

    const acc = transition(req.value.loan, { type: "accept", inHandConfirmed: true }, asLender());
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    expect(acc.value.loan.handoffCode).toBeNull();
  });

  it("confirms like a meet-up: photo on each side, no code, no occupancy effects", () => {
    const a = loanIn("accepted", { handoffMethod: "courier" });
    expect(transition(a, { type: "confirm_out", code: "ABC123" }, asLender())).toMatchObject({
      ok: false,
      error: { code: "photo_required" },
    });
    const first = transition(a, { type: "confirm_out", photoPath: "rider.jpg" }, asLender());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = transition(
      first.value.loan,
      { type: "confirm_out", photoPath: "arrived.jpg" },
      asBorrower(),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.loan.state).toBe("on_loan");
    expect(kinds(second.value.effects)).not.toContain("drop_point_occupancy");
  });
});

describe("accepted (drop point)", () => {
  const dp = loanIn("accepted", {
    handoffMethod: "drop_point",
    dropPointId: "dp-1",
    handoffCode: CODE,
  });

  it("lender drops with the code (occupancy +1), borrower collects with the code (occupancy -1)", () => {
    expect(transition(dp, { type: "confirm_out" }, asLender())).toMatchObject({
      ok: false,
      error: { code: "code_required" },
    });
    expect(transition(dp, { type: "confirm_out", code: "WRONG1" }, asLender())).toMatchObject({
      ok: false,
      error: { code: "wrong_code" },
    });
    expect(transition(dp, { type: "confirm_out", code: CODE }, asBorrower())).toMatchObject({
      ok: false,
      error: { code: "collect_before_drop" },
    });

    const dropped = transition(dp, { type: "confirm_out", code: CODE.toLowerCase() }, asLender());
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    expect(find(dropped.value.effects, "drop_point_occupancy")).toEqual([
      { kind: "drop_point_occupancy", dropPointId: "dp-1", delta: 1 },
    ]);
    expect(find(dropped.value.effects, "loan_photo")).toHaveLength(0);

    const collected = transition(
      dropped.value.loan,
      { type: "confirm_out", code: CODE },
      asBorrower(),
    );
    expect(collected.ok && collected.value.loan.state).toBe("on_loan");
    expect(collected.ok && find(collected.value.effects, "drop_point_occupancy")[0].delta).toBe(-1);
  });

  it("auto-confirm after a lender drop frees the shelf", () => {
    const res = transition(
      { ...dp, outLenderConfirmedAt: ago(73 * H) },
      { type: "auto_confirm_out" },
      asSystem(),
    );
    expect(res.ok && find(res.value.effects, "drop_point_occupancy")).toEqual([
      { kind: "drop_point_occupancy", dropPointId: "dp-1", delta: -1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// on_loan / overdue
// ---------------------------------------------------------------------------

describe("on_loan", () => {
  it("borrower may extend once by 7 days", () => {
    const l = loanIn("on_loan");
    expect(transition(l, { type: "extend" }, asLender())).toMatchObject({
      ok: false,
      error: { code: "not_borrower" },
    });
    const e = transition(l, { type: "extend" }, asBorrower());
    expect(e.ok && e.value.loan).toMatchObject({
      state: "on_loan",
      extended: true,
      dueAt: new Date(l.dueAt!.getTime() + 7 * D),
    });
    expect(e.ok && find(e.value.effects, "notify")[0]).toMatchObject({
      memberId: LENDER,
      template: "extended",
    });
    expect(transition(e.ok ? e.value.loan : l, { type: "extend" }, asBorrower())).toMatchObject({
      ok: false,
      error: { code: "already_extended" },
    });
  });

  it("overdue_tick only after due_at", () => {
    const l = loanIn("on_loan", { dueAt: ahead(1 * H) });
    expect(transition(l, { type: "overdue_tick" }, asSystem())).toMatchObject({
      ok: false,
      error: { code: "too_early" },
    });
    const o = transition(
      loanIn("on_loan", { dueAt: ago(1 * H) }),
      { type: "overdue_tick" },
      asSystem(),
    );
    expect(o.ok && o.value.loan.state).toBe("overdue");
    expect(
      o.ok &&
        find(o.value.effects, "notify")
          .map((n) => n.memberId)
          .sort(),
    ).toEqual([BORROWER, LENDER].sort());
  });
});

describe("return", () => {
  it("borrower confirms with a photo; lender confirms with photo and condition; second confirmation completes", () => {
    const l = loanIn("on_loan");
    expect(transition(l, { type: "confirm_return", photoPath: "r.jpg" }, asLender())).toMatchObject(
      { ok: false, error: { code: "condition_required" } },
    );
    expect(transition(l, { type: "confirm_return", condition: "good" }, asLender())).toMatchObject({
      ok: false,
      error: { code: "photo_required" },
    });

    const b = transition(l, { type: "confirm_return", photoPath: "rb.jpg" }, asBorrower());
    expect(b.ok && b.value.loan.state).toBe("on_loan");
    expect(b.ok && find(b.value.effects, "notify")[0]).toMatchObject({
      memberId: LENDER,
      template: "return_confirmed_one_side",
    });
    if (!b.ok) return;

    const done = transition(
      b.value.loan,
      { type: "confirm_return", photoPath: "rl.jpg", condition: "worn" },
      asLender(),
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.loan).toMatchObject({
      state: "returned",
      returnedAt: NOW,
      returnCondition: "worn",
      poolMonth: new Date("2026-09-01T00:00:00Z"),
    });
    expect(find(done.value.effects, "loan_photo")[0]).toMatchObject({
      phase: "return",
      condition: "worn",
      takenBy: LENDER,
    });
    expect(find(done.value.effects, "set_copy_availability")[0].availability).toBe("available");
    expect(find(done.value.effects, "verify_copy")).toHaveLength(1);
    expect(
      find(done.value.effects, "trust_event")
        .map((t) => `${t.memberId}:${t.trustKind}`)
        .sort(),
    ).toEqual(
      [
        `${BORROWER}:return_on_time`,
        `${BORROWER}:borrow_completed`,
        `${LENDER}:lend_completed`,
      ].sort(),
    );
    expect(find(done.value.effects, "set_first_borrow_completed")).toHaveLength(1);
  });

  it("does not re-verify an already verified copy and records a late return from overdue", () => {
    const o = loanIn("overdue", { returnBorrowerConfirmedAt: ago(1 * H) });
    const res = transition(
      o,
      { type: "confirm_return", photoPath: "rl.jpg", condition: "good" },
      asLender({ copy: { ...copy, verificationStatus: "verified" } }),
    );
    expect(res.ok && find(res.value.effects, "verify_copy")).toHaveLength(0);
    expect(
      res.ok && find(res.value.effects, "trust_event").some((t) => t.trustKind === "return_late"),
    ).toBe(true);
  });

  it("drop-point return: borrower drops, lender collects", () => {
    const l = loanIn("on_loan", {
      handoffMethod: "drop_point",
      dropPointId: "dp-1",
      handoffCode: CODE,
    });
    expect(
      transition(l, { type: "confirm_return", code: CODE, condition: "good" }, asLender()),
    ).toMatchObject({ ok: false, error: { code: "collect_before_drop" } });
    const dropped = transition(l, { type: "confirm_return", code: CODE }, asBorrower());
    expect(dropped.ok && find(dropped.value.effects, "drop_point_occupancy")[0].delta).toBe(1);
    if (!dropped.ok) return;
    const collected = transition(
      dropped.value.loan,
      { type: "confirm_return", code: CODE, condition: "good" },
      asLender(),
    );
    expect(collected.ok && collected.value.loan.state).toBe("returned");
    expect(collected.ok && find(collected.value.effects, "drop_point_occupancy")[0].delta).toBe(-1);
  });

  it("auto-confirms a one-sided return after 72 h and assumes good condition", () => {
    const res = transition(
      loanIn("on_loan", { returnBorrowerConfirmedAt: ago(73 * H) }),
      { type: "auto_confirm_return" },
      asSystem(),
    );
    expect(res.ok && res.value.loan).toMatchObject({
      state: "returned",
      autoConfirmedSide: "borrower",
      returnCondition: "good",
    });
    expect(
      transition(
        loanIn("on_loan", { returnBorrowerConfirmedAt: ago(71 * H) }),
        { type: "auto_confirm_return" },
        asSystem(),
      ),
    ).toMatchObject({ ok: false, error: { code: "too_early" } });
  });
});

describe("lost", () => {
  it("14 days past due: ledger both sides, copy lost, borrower suspended 90 days, trust hit", () => {
    expect(
      transition(loanIn("overdue", { dueAt: ago(13 * D) }), { type: "lost_tick" }, asSystem()),
    ).toMatchObject({ ok: false, error: { code: "too_early" } });
    const res = transition(
      loanIn("overdue", { dueAt: ago(15 * D) }),
      { type: "lost_tick" },
      asSystem(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.loan.state).toBe("lost");
    expect(find(res.value.effects, "set_copy_availability")[0].availability).toBe("lost");
    expect(find(res.value.effects, "ledger")).toEqual([
      expect.objectContaining({
        memberId: BORROWER,
        account: "deposit",
        ledgerKind: "deposit_charge",
        amountPaise: -49900,
      }),
      expect.objectContaining({
        memberId: LENDER,
        account: "payout",
        ledgerKind: "lost_book_credit",
        amountPaise: 49900,
      }),
    ]);
    expect(find(res.value.effects, "suspend_member")[0]).toEqual({
      kind: "suspend_member",
      memberId: BORROWER,
      until: ahead(90 * D),
    });
    expect(find(res.value.effects, "trust_event")[0]).toMatchObject({
      memberId: BORROWER,
      trustKind: "book_lost",
    });
  });
});

// ---------------------------------------------------------------------------
// disputes
// ---------------------------------------------------------------------------

describe("dispute", () => {
  it("either party may open within 48 h of return; outsiders and late openers may not", () => {
    const r = loanIn("returned", { returnedAt: ago(47 * H) });
    expect(
      transition(r, { type: "dispute", reason: "Water damage on the cover." }, asOutsider()),
    ).toMatchObject({ ok: false, error: { code: "not_a_party" } });
    expect(
      transition(
        loanIn("returned", { returnedAt: ago(48 * H + 60_000) }),
        { type: "dispute", reason: "x" },
        asLender(),
      ),
    ).toMatchObject({ ok: false, error: { code: "dispute_window_closed" } });
    const res = transition(
      r,
      { type: "dispute", reason: "Water damage on the cover." },
      asBorrower(),
    );
    expect(res.ok && res.value.loan.state).toBe("disputed");
    expect(res.ok && find(res.value.effects, "create_dispute")[0]).toMatchObject({
      openedBy: BORROWER,
    });
    expect(res.ok && find(res.value.effects, "notify")[0]).toMatchObject({
      memberId: LENDER,
      template: "dispute_opened",
    });
    expect(res.ok && find(res.value.effects, "notify_admins")).toHaveLength(1);
  });

  it("only admins resolve; charges ledger both sides and marks dispute_lost on the borrower", () => {
    const d = loanIn("disputed");
    expect(
      transition(d, { type: "resolve", resolution: "dismissed", note: "n" }, asLender()),
    ).toMatchObject({ ok: false, error: { code: "not_admin" } });

    const dismissed = transition(
      d,
      { type: "resolve", resolution: "dismissed", note: "No new damage." },
      asAdmin(),
    );
    expect(dismissed.ok && dismissed.value.loan.state).toBe("resolved");
    expect(dismissed.ok && find(dismissed.value.effects, "ledger")).toHaveLength(0);
    expect(dismissed.ok && find(dismissed.value.effects, "trust_event")).toHaveLength(0);

    const partial = transition(
      d,
      {
        type: "resolve",
        resolution: "partial_charge",
        chargePaise: 15000,
        note: "Cover replacement.",
      },
      asAdmin(),
    );
    expect(partial.ok && find(partial.value.effects, "ledger").map((l) => l.amountPaise)).toEqual([
      -15000, 15000,
    ]);
    expect(partial.ok && find(partial.value.effects, "trust_event")[0]).toMatchObject({
      memberId: BORROWER,
      trustKind: "dispute_lost",
    });
    expect(partial.ok && find(partial.value.effects, "resolve_dispute")[0]).toMatchObject({
      resolution: "partial_charge",
      chargePaise: 15000,
      resolvedBy: ADMIN,
    });

    const full = transition(
      d,
      { type: "resolve", resolution: "full_charge", note: "Unusable." },
      asAdmin(),
    );
    expect(full.ok && find(full.value.effects, "ledger")[0].amountPaise).toBe(-49900);

    expect(
      transition(
        d,
        { type: "resolve", resolution: "partial_charge", chargePaise: 0, note: "n" },
        asAdmin(),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_charge" } });
    expect(
      transition(
        d,
        { type: "resolve", resolution: "partial_charge", chargePaise: 60000, note: "n" },
        asAdmin(),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_charge" } });
  });
});

describe("purity", () => {
  it("does not mutate its inputs", () => {
    const l = loanIn("accepted");
    const snapshot = structuredClone(l);
    transition(l, { type: "confirm_out", photoPath: "p" }, asLender());
    expect(l).toEqual(snapshot);
  });
});
