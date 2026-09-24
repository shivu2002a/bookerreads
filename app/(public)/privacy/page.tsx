import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy" };

/** Requirement 25.1 / 15.x. Draft pending legal review. */
export default function PrivacyPage() {
  return (
    <article className="legal">
      <h1>Privacy notice</h1>
      <p className="text-muted-foreground">
        Last updated 23 September 2026. Draft pending legal review.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Phone number.</strong> Used to sign you in with a one-time code. It is stored only
          in our authentication provider (Supabase, Mumbai region). Our application database stores
          a one-way hash so support can look you up; the number itself is never shown to other
          members.
        </li>
        <li>
          <strong>Display name and home cluster.</strong> Shown to other members. We store which
          neighbourhood cluster you belong to, not your address or precise location.
        </li>
        <li>
          <strong>Books and photos.</strong> Listing photos are public. Handover and return photos
          are visible only to the two parties to that loan and to BookerReads staff reviewing a
          dispute.
        </li>
        <li>
          <strong>Loan and payment records.</strong> Requests, handoffs, returns, chat messages,
          deposits, pool credits, and payouts. Card and UPI details are handled by Razorpay; we
          store Razorpay&apos;s identifiers and your payout UPI ID.
        </li>
        <li>
          <strong>Device and usage data.</strong> Error reports (Sentry) and product analytics
          (PostHog) keyed to your member ID, never to your phone number.
        </li>
      </ul>

      <h2>What other members see</h2>
      <p>
        Your display name, cluster, trust score, member-since month, acceptance rate, and the books
        you have listed. In a loan, the other party also sees your chat messages and handover
        photos. Nobody sees your phone number or address.
      </p>

      <h2>Messages we send</h2>
      <p>
        Transactional messages about your loans and membership by WhatsApp, with SMS fallback. We do
        not send marketing through these channels.
      </p>

      <h2>Retention</h2>
      <p>
        Loan history and ledger entries are kept for as long as your account exists and for seven
        years afterwards for accounting. Chat is readable by the parties for 48 hours after a loan
        closes. When you delete your account your profile is removed and your books unlisted; loan
        records remain visible to the other party as history.
      </p>

      <h2>Your choices</h2>
      <p>
        You can change your display name, unlist books, cancel your plan, request your deposit
        refund, and delete your account from the app. For a copy of your data or any question, write
        to hello@bookerreads.in.
      </p>

      <h2>Providers</h2>
      <p>
        Supabase (database, auth, storage; Mumbai), Vercel (hosting; Mumbai), Razorpay (payments and
        payouts), Interakt and MSG91 (messages), Google Books and Open Library (book metadata),
        Sentry and PostHog (monitoring).
      </p>
    </article>
  );
}
