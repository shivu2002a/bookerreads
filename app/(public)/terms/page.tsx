import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { loadConfig } from "@/lib/config/load";
import { CONFIG_DEFAULTS } from "@/lib/config/schema";
import { formatPaise } from "@/lib/money";

export const metadata: Metadata = { title: "Terms" };
export const revalidate = 3600;

/**
 * Requirement 25.1. Amounts and windows are read from config so the document
 * matches what the system actually enforces. Draft for review by a lawyer
 * before launch; see docs/compliance.md.
 */
/** Falls back to defaults so the page renders at build time and if the DB is unreachable. */
async function configOrDefaults() {
  try {
    return await loadConfig(getDb());
  } catch {
    return CONFIG_DEFAULTS;
  }
}

export default async function TermsPage() {
  const c = await configOrDefaults();
  const deposit = formatPaise(c.deposit_paise);
  const threshold = formatPaise(c.payout_threshold_paise);
  return (
    <article className="legal">
      <h1>Terms of membership</h1>
      <p className="text-muted-foreground">
        Last updated 23 September 2026. Draft pending legal review.
      </p>

      <h2>1. What BookerReads is</h2>
      <p>
        BookerReads is a members-only book lending network in Bangalore. Members list books they own
        and lend them to other members in the same neighbourhood cluster. BookerReads operates the
        platform, holds deposits, and distributes the lender pool. BookerReads does not own the
        books and is not a party to the loan between two members, except as described in these
        terms.
      </p>

      <h2>2. Listing</h2>
      <p>
        Listing is free. You may list only books you own and are entitled to lend. Each listing
        requires a photo of your physical copy taken in the app. You set the replacement value
        between ₹100 and ₹1,000; that value is what a borrower pays if the book is lost. New
        accounts may list up to {c.new_account_listing_cap} books in their first{" "}
        {c.new_account_age_days} days.
      </p>

      <h2>3. Borrowing</h2>
      <p>
        To borrow you need an active monthly plan, a refundable deposit of {deposit}, and at least{" "}
        {c.borrow_gate.min_listed_copies} books listed with photos, one of which has been verified
        (completed a loan or checked in person) or one loan completed as a lender. Plans set how
        many books you may have at once and for how long. Requests you do not respond to within{" "}
        {c.request_timeout_hours} hours expire.
      </p>

      <h2>4. Handoffs, returns, and timing</h2>
      <p>
        Handoffs happen in person at a public place or by a Porter rider that the borrower books and
        pays for directly; BookerReads is not a party to that booking. Both parties confirm each
        handoff in the app; if one party has confirmed and the other has not after{" "}
        {c.handoff_auto_confirm_hours} hours, the handoff is recorded in favour of the confirming
        party. An accepted loan with no handoff within {c.handoff_timeout_days} days expires and
        counts as a no-show against whoever did not confirm.
      </p>
      <p>
        Books are due back at the end of your plan&apos;s loan period. You may extend once by{" "}
        {c.extension_days} days. After the due date the loan is overdue; after{" "}
        {c.overdue_to_lost_days} further days the book is treated as lost.
      </p>

      <h2>5. Deposit, lost books, and damage</h2>
      <p>
        Your deposit of {deposit} is held by BookerReads as a liability owed to you and is never
        treated as revenue. When a book is lost, its replacement value is charged against your
        deposit and credited to the lender, you are suspended from borrowing for{" "}
        {c.lost_suspension_days} days, and you must top the deposit back up before requesting again.
        If the charge exceeds your deposit, BookerReads pays the lender the difference and may
        recover it from you.
      </p>
      <p>
        Either party may report a condition problem within {c.dispute_window_hours} hours of a
        return. BookerReads reviews the handover and return photos and decides: dismiss, a partial
        charge, or the full replacement value. That decision is final within the platform. Trust
        scores are adjusted accordingly.
      </p>

      <h2>6. Lender pool and payouts</h2>
      <p>
        Each month, {c.pool_pct}% of subscription revenue collected that month forms the lender
        pool. It is divided equally among all loans that reached &quot;returned&quot; in the month
        (including loans later disputed), rounded down to the rupee; any remainder carries into the
        next month. Balances of {threshold} or more are paid to a verified UPI ID on the 1st of the
        following month. Balances below {threshold} roll over.
      </p>
      <p>
        <strong>
          If you delete your account with a payout balance below {threshold}, that balance is
          forfeited.
        </strong>{" "}
        Request a payout, or wait until the balance reaches the threshold, before deleting.
      </p>

      <h2>7. Cancelling and refunds</h2>
      <p>
        You may cancel your plan at any time; borrowing continues to the end of the paid period.
        Your deposit is refunded to the original payment method within 7 days of cancellation once
        you have no open loans or disputes. Deposits are not refunded while a book you borrowed is
        unreturned.
      </p>

      <h2>8. Trust score and suspension</h2>
      <p>
        Every member has a trust score from 0 to 100, starting at 50, derived from on-time returns,
        late returns, lost books, disputes lost, no-shows, unanswered requests, completed loans, and
        account age. Members below {c.borrow_gate.min_trust_score} cannot borrow until the score
        recovers through lending. Lenders may set a minimum trust score on individual copies.
        BookerReads may suspend accounts for conduct that harms other members.
      </p>

      <h2>9. Conduct</h2>
      <p>
        Use in-app chat and handoff codes only; do not ask other members for their phone number or
        address. Do not list books you do not own, misrepresent condition, or use the platform for
        sales. Be on time.
      </p>

      <h2>10. Changes</h2>
      <p>
        Prices, plan limits, deposit amount, and the pool percentage may change with 30 days&apos;
        notice in the app. Changes do not apply to loans already in progress.
      </p>

      <h2>11. Contact</h2>
      <p>hello@bookerreads.in</p>
    </article>
  );
}
