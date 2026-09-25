import type { LoanState, Party } from "./types";

export type NextStep = {
  title: string;
  body: string;
  /** Which action block LoanActions should render. */
  action:
    | "none"
    | "respond"
    | "pay"
    | "handoff_meetup"
    | "handoff_drop"
    | "handoff_collect"
    | "wait_other"
    | "return_meetup"
    | "return_drop"
    | "return_collect"
    | "dispute_window";
};

type LoanShape = {
  state: LoanState;
  handoffMethod: "meetup" | "drop_point" | "courier";
  rentalPaise: number;
  paymentDueAt: Date | null;
  paidAt: Date | null;
  outLenderConfirmedAt: Date | null;
  outBorrowerConfirmedAt: Date | null;
  returnLenderConfirmedAt: Date | null;
  returnBorrowerConfirmedAt: Date | null;
  returnedAt: Date | null;
  dueAt: Date | null;
  autoConfirmedSide: Party | null;
};

const fmtDate = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const fmtTime = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

/** Plain-language "what happens next" for the loan page, per party and state (task 12.3). */
export function nextStep(
  loan: LoanShape,
  party: Party,
  now = new Date(),
  disputeWindowHours = 48,
): NextStep {
  const isLender = party === "lender";
  const drop = loan.handoffMethod === "drop_point";
  const porter = loan.handoffMethod === "courier";
  const other = isLender ? "the borrower" : "the lender";

  switch (loan.state) {
    case "requested":
      return isLender
        ? {
            title: "Request waiting for you",
            body: "Accept if you have the book in hand, or decline. Unanswered requests expire after 48 hours.",
            action: "respond",
          }
        : {
            title: "Waiting for the lender",
            body: "Lenders usually reply within a day. If there's no answer in 48 hours the request expires and the book frees up again.",
            action: "none",
          };

    case "accepted": {
      // Payment comes before any handoff talk (Requirement 5).
      if (!loan.paidAt) {
        const by = loan.paymentDueAt ? fmtTime.format(loan.paymentDueAt) : "soon";
        return isLender
          ? {
              title: "Waiting for payment",
              body: `The borrower has until ${by} to pay ${rupees(loan.rentalPaise)}. Once they do, you'll arrange the handoff here.`,
              action: "none",
            }
          : {
              title: `Pay ${rupees(loan.rentalPaise)} to confirm`,
              body: `The lender said yes. Pay by ${by} to lock in the book; otherwise the request expires and the copy frees up.`,
              action: "pay",
            };
      }
      const mine = isLender ? loan.outLenderConfirmedAt : loan.outBorrowerConfirmedAt;
      const theirs = isLender ? loan.outBorrowerConfirmedAt : loan.outLenderConfirmedAt;
      if (mine && !theirs) {
        return {
          title: "Waiting for " + other,
          body: `You've confirmed. Once ${other} confirms too, the loan starts. If they don't within 72 hours it's confirmed automatically.`,
          action: "wait_other",
        };
      }
      if (drop) {
        return isLender
          ? {
              title: "Drop the book off",
              body: "Take it to the drop point, scan the poster QR, and enter your handoff code.",
              action: "handoff_drop",
            }
          : theirs
            ? {
                title: "Ready to collect",
                body: "The book is at the drop point. Scan the poster QR there and enter the handoff code to collect it.",
                action: "handoff_collect",
              }
            : {
                title: "Waiting for the drop-off",
                body: "The lender will leave the book at the drop point. We'll message you when it's there.",
                action: "none",
              };
      }
      if (porter) {
        return isLender
          ? {
              title: "Arrange the Porter pickup",
              body: `Share a pickup address and time in chat. When the rider collects the book, tap "Handed over" and take a photo of it.`,
              action: "handoff_meetup",
            }
          : {
              title: "Book a Porter rider",
              body: `Agree pickup details in chat, then book Porter yourself. When the book arrives, tap "Received" and take a photo of it.`,
              action: "handoff_meetup",
            };
      }
      return {
        title: "Arrange the meet-up",
        body: `Agree a time and place in chat. When you hand over, both of you tap "Handed over" and take a photo of the book.`,
        action: "handoff_meetup",
      };
    }

    case "on_loan":
    case "overdue": {
      const mine = isLender ? loan.returnLenderConfirmedAt : loan.returnBorrowerConfirmedAt;
      const theirs = isLender ? loan.returnBorrowerConfirmedAt : loan.returnLenderConfirmedAt;
      const due = loan.dueAt ? fmtDate.format(loan.dueAt) : "soon";
      if (mine && !theirs) {
        return {
          title: "Waiting for " + other,
          body: `You've confirmed the return. Once ${other} confirms, the loan is complete (or after 72 hours automatically).`,
          action: "wait_other",
        };
      }
      const overdue = loan.state === "overdue";
      if (drop) {
        return isLender
          ? theirs
            ? {
                title: "Collect your book",
                body: "It's back at the drop point. Scan the poster QR, enter the code, and note the condition.",
                action: "return_collect",
              }
            : {
                title: overdue ? "Return is overdue" : `Due back ${due}`,
                body: "The borrower will return it to the drop point. You'll confirm receipt and condition then.",
                action: "none",
              }
          : theirs
            ? {
                title: "Return confirmed by lender",
                body: "Waiting for your confirmation.",
                action: "return_drop",
              }
            : {
                title: overdue ? "This book is overdue" : `Due back ${due}`,
                body: "Return it to the drop point: scan the poster QR and enter your handoff code.",
                action: "return_drop",
              };
      }
      return isLender
        ? {
            title: overdue ? "Return is overdue" : `Due back ${due}`,
            body: 'When you get the book back, tap "Received", take a photo, and note its condition.',
            action: "return_meetup",
          }
        : {
            title: overdue ? "This book is overdue" : `Due back ${due}`,
            body: porter
              ? "Book a Porter rider back to the lender and share the details in chat. Both of you confirm with a photo."
              : "Arrange the return in chat. Both of you confirm the handover with a photo.",
            action: "return_meetup",
          };
    }

    case "returned": {
      const closesAt = loan.returnedAt
        ? new Date(loan.returnedAt.getTime() + disputeWindowHours * 3_600_000)
        : null;
      const open = closesAt ? now < closesAt : false;
      return {
        title: "Loan complete",
        body: open
          ? `If the book came back damaged or something else went wrong, report it before ${closesAt ? fmtDate.format(closesAt) : "the window closes"}.`
          : "Thanks for keeping it smooth.",
        action: open ? "dispute_window" : "none",
      };
    }
    case "disputed":
      return {
        title: "Under review",
        body: "An admin is looking at both sets of photos. You'll hear back with the decision.",
        action: "none",
      };
    case "resolved":
      return { title: "Dispute resolved", body: "See the decision below.", action: "none" };
    case "declined":
      return {
        title: "Request declined",
        body: isLender ? "You declined this request." : "The lender declined. Try another copy.",
        action: "none",
      };
    case "expired":
      return { title: "Expired", body: "This request or handoff timed out.", action: "none" };
    case "lost":
      return {
        title: "Marked lost",
        body: isLender
          ? "The replacement value has been credited to your payout balance."
          : "The replacement value was charged to your deposit.",
        action: "none",
      };
  }
}
