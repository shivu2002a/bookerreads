import { formatPaise } from "@/lib/money";

/**
 * Every transactional message the system can send (Requirement 11). Each has
 * the pre-approved Interakt/WhatsApp template name, the ordered body variables
 * that template expects, and an SMS variant under 160 characters for fallback.
 * There are deliberately no marketing templates here (Requirement 11.3): the
 * union type is the enforcement.
 */

export type TemplateVars = Record<string, string | number>;

type Def = {
  whatsapp: string;
  /** Builds the ordered WhatsApp body variables from vars. */
  params: (v: TemplateVars) => string[];
  sms: (v: TemplateVars) => string;
  /** Once-per-loan-per-day dedupe (Requirement 11.2). */
  dailyReminder?: true;
};

const s = (v: TemplateVars, k: string, fallback = "") =>
  v[k] === undefined ? fallback : String(v[k]);
const money = (v: TemplateVars, k: string) =>
  typeof v[k] === "number" ? formatPaise(v[k] as number) : s(v, k);
const date = (v: TemplateVars, k: string) => {
  const raw = s(v, k);
  const d = new Date(raw);
  return Number.isNaN(d.getTime())
    ? raw
    : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(d);
};
const link = (v: TemplateVars) => s(v, "link", "bookerreads.in");

export const TEMPLATES = {
  // loans
  request_received: {
    whatsapp: "br_request_received",
    params: (v) => [
      s(v, "borrower"),
      s(v, "book"),
      s(v, "trust"),
      s(v, "onTime"),
      s(v, "handoff"),
      link(v),
    ],
    sms: (v) =>
      `BookerReads: ${s(v, "borrower")} (trust ${s(v, "trust")}, ${s(v, "onTime")} on-time returns) wants "${s(v, "book")}" via ${s(v, "handoff")}. Reply within 48h: ${link(v)}`,
  },
  request_accepted: {
    whatsapp: "br_request_accepted",
    params: (v) => [s(v, "lender"), s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: ${s(v, "lender")} accepted your request for "${s(v, "book")}". Arrange the handoff: ${link(v)}`,
  },
  request_declined: {
    whatsapp: "br_request_declined",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: your request for "${s(v, "book")}" was declined. Find another copy: ${link(v)}`,
  },
  request_expired: {
    whatsapp: "br_request_expired",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: no reply on "${s(v, "book")}" in 48h, so the request expired. Try another copy: ${link(v)}`,
  },
  payment_due: {
    whatsapp: "br_payment_due",
    params: (v) => [s(v, "lender"), s(v, "book"), money(v, "amountPaise"), link(v)],
    sms: (v) =>
      `BookerReads: ${s(v, "lender")} accepted your request for "${s(v, "book")}". Pay ${money(v, "amountPaise")} within 24h to confirm: ${link(v)}`,
  },
  payment_received: {
    whatsapp: "br_payment_received",
    params: (v) => [s(v, "borrower"), s(v, "book"), money(v, "amountPaise"), link(v)],
    sms: (v) =>
      `BookerReads: ${s(v, "borrower")} paid ${money(v, "amountPaise")} for "${s(v, "book")}". Arrange the handoff: ${link(v)}`,
  },
  payment_expired: {
    whatsapp: "br_payment_expired",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: the payment window for "${s(v, "book")}" passed, so the request expired. ${link(v)}`,
  },
  payment_refunded: {
    whatsapp: "br_payment_refunded",
    params: (v) => [s(v, "book"), money(v, "amountPaise")],
    sms: (v) =>
      `BookerReads: the handoff for "${s(v, "book")}" didn't happen. ${money(v, "amountPaise")} is being refunded to you.`,
  },
  handoff_confirmed_one_side: {
    whatsapp: "br_handoff_one_side",
    params: (v) => [s(v, "other"), s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: ${s(v, "other")} confirmed handing over "${s(v, "book")}". Please confirm too: ${link(v)}`,
  },
  handoff_nudge: {
    whatsapp: "br_handoff_nudge",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" is waiting on your handover confirmation. It auto-confirms in 24h: ${link(v)}`,
    dailyReminder: true,
  },
  handoff_auto_confirmed: {
    whatsapp: "br_handoff_auto",
    params: (v) => [s(v, "book"), date(v, "dueAt"), link(v)],
    sms: (v) =>
      `BookerReads: handover of "${s(v, "book")}" was auto-confirmed. Due ${date(v, "dueAt")}: ${link(v)}`,
  },
  handoff_expired: {
    whatsapp: "br_handoff_expired",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: the handoff for "${s(v, "book")}" didn't happen within 5 days and has expired: ${link(v)}`,
  },
  on_loan: {
    whatsapp: "br_on_loan",
    params: (v) => [s(v, "book"), date(v, "dueAt"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" is on loan. Due back ${date(v, "dueAt")}: ${link(v)}`,
  },
  extended: {
    whatsapp: "br_extended",
    params: (v) => [s(v, "book"), date(v, "dueAt"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" was extended. New due date ${date(v, "dueAt")}: ${link(v)}`,
  },
  due_soon: {
    whatsapp: "br_due_soon",
    params: (v) => [s(v, "book"), date(v, "dueAt"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" is due back ${date(v, "dueAt")}. Arrange the return: ${link(v)}`,
    dailyReminder: true,
  },
  overdue: {
    whatsapp: "br_overdue",
    params: (v) => [s(v, "book"), date(v, "dueAt"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" is overdue (due ${date(v, "dueAt")}). Please return it soon: ${link(v)}`,
    dailyReminder: true,
  },
  return_confirmed_one_side: {
    whatsapp: "br_return_one_side",
    params: (v) => [s(v, "other"), s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: ${s(v, "other")} confirmed the return of "${s(v, "book")}". Please confirm too: ${link(v)}`,
  },
  return_nudge: {
    whatsapp: "br_return_nudge",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" is waiting on your return confirmation. It auto-confirms in 24h: ${link(v)}`,
    dailyReminder: true,
  },
  return_auto_confirmed: {
    whatsapp: "br_return_auto",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: the return of "${s(v, "book")}" was auto-confirmed. Loan complete: ${link(v)}`,
  },
  returned: {
    whatsapp: "br_returned",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" is back. Loan complete. Report a problem within 48h: ${link(v)}`,
  },
  book_lost: {
    whatsapp: "br_book_lost",
    params: (v) => [s(v, "book"), money(v, "amountPaise"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" is marked lost. ${money(v, "amountPaise")} has been applied. Details: ${link(v)}`,
  },
  dispute_opened: {
    whatsapp: "br_dispute_opened",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: a problem was reported on the return of "${s(v, "book")}". An admin will review: ${link(v)}`,
  },
  dispute_resolved: {
    whatsapp: "br_dispute_resolved",
    params: (v) => [
      s(v, "book"),
      s(v, "resolution").replace("_", " "),
      money(v, "chargePaise"),
      link(v),
    ],
    sms: (v) =>
      `BookerReads: the dispute on "${s(v, "book")}" is resolved: ${s(v, "resolution").replace("_", " ")}${Number(v.chargePaise) > 0 ? ` (${money(v, "chargePaise")})` : ""}. ${link(v)}`,
  },
  copy_auto_unlisted: {
    whatsapp: "br_copy_unlisted",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" was unlisted after repeated declines or a missed handoff. Relist any time: ${link(v)}`,
  },
  still_have_it: {
    whatsapp: "br_still_have_it",
    params: (v) => [s(v, "book"), link(v)],
    sms: (v) =>
      `BookerReads: do you still have "${s(v, "book")}"? Tap to keep it listed, or it's unlisted in 14 days: ${link(v)}`,
  },
  drop_point_uncollected: {
    whatsapp: "br_dp_uncollected",
    params: (v) => [s(v, "book"), s(v, "venue"), link(v)],
    sms: (v) =>
      `BookerReads: "${s(v, "book")}" has been at ${s(v, "venue")} for 5+ days uncollected: ${link(v)}`,
  },
  // membership
  membership_activated: {
    whatsapp: "br_activated",
    params: (v) => [link(v)],
    sms: (v) => `BookerReads: you're all set to borrow. Find your next read: ${link(v)}`,
  },
  membership_cancelled: {
    whatsapp: "br_cancelled",
    params: (v) => [link(v)],
    sms: (v) =>
      `BookerReads: your membership is cancelled. Your deposit is refundable once loans are closed: ${link(v)}`,
  },
  deposit_refunded: {
    whatsapp: "br_deposit_refunded",
    params: (v) => [money(v, "amountPaise")],
    sms: (v) =>
      `BookerReads: your deposit of ${money(v, "amountPaise")} has been refunded. It reaches you within 7 days.`,
  },
  cluster_opened: {
    whatsapp: "br_cluster_opened",
    params: (v) => [s(v, "cluster"), link(v)],
    sms: (v) =>
      `BookerReads: ${s(v, "cluster")} is now open! Set it as your area and start borrowing: ${link(v)}`,
  },
  // money
  payout_batch_ready: {
    whatsapp: "br_payout_batch_ready",
    params: (v) => [s(v, "month"), s(v, "count"), money(v, "totalPaise"), link(v)],
    sms: (v) =>
      `BookerReads admin: payout batch ${s(v, "month")} has ${s(v, "count")} payout(s) totalling ${money(v, "totalPaise")}. Export: ${link(v)}`,
  },
  payout_sent: {
    whatsapp: "br_payout_sent",
    params: (v) => [money(v, "amountPaise"), s(v, "upiId")],
    sms: (v) =>
      `BookerReads: ${money(v, "amountPaise")} has been sent to ${s(v, "upiId")}. Thanks for lending!`,
  },
} as const satisfies Record<string, Def>;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];

export function isTemplateName(x: string): x is TemplateName {
  return x in TEMPLATES;
}

export function isDailyReminder(name: TemplateName): boolean {
  return "dailyReminder" in TEMPLATES[name];
}

export function renderSms(name: TemplateName, vars: TemplateVars): string {
  return TEMPLATES[name].sms(vars);
}

export function whatsappParams(name: TemplateName, vars: TemplateVars): string[] {
  return TEMPLATES[name].params(vars);
}
