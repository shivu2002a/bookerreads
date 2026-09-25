import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConditionBadge, TrustScore } from "@/components/badges";
import { BookCover } from "@/components/book-cover";
import { LoanActions } from "@/components/loan-actions";
import { LoanChat } from "@/components/loan-chat";
import { getDb } from "@/db/client";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { nextStep } from "@/lib/loans/next-step";
import { getLoanForViewer, isChatOpen } from "@/lib/loans/queries";
import { formatPaise } from "@/lib/money";
import { signedReadUrl } from "@/lib/photos/storage";
import { clusters } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata: Metadata = { title: "Loan" };

const when = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

const EVENT_LABEL: Record<string, string> = {
  "loan.requested": "Requested",
  "loan.accepted": "Accepted",
  "loan.paid": "Rental paid",
  "loan.payment_expired": "Payment window passed",
  "payment.refund_requested": "Refund requested",
  "payment.refunded": "Rental refunded",
  "loan.declined": "Declined",
  "loan.expired": "Request expired",
  "loan.handoff_confirmed": "Handover confirmed by one side",
  "loan.on_loan": "Handed over, loan started",
  "loan.handoff_expired": "Handoff expired",
  "loan.extended": "Extended by 7 days",
  "loan.overdue": "Overdue",
  "loan.return_confirmed": "Return confirmed by one side",
  "loan.returned": "Returned",
  "loan.lost": "Marked lost",
  "loan.disputed": "Problem reported",
  "loan.resolved": "Dispute resolved",
  "ledger.deposit_shortfall": "Deposit could not cover the full charge",
};

export default async function LoanPage({ params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params;
  const member = await requireOnboardedMember();
  const db = getDb();
  const [loan, config] = await Promise.all([
    getLoanForViewer(db, loanId, { id: member.id, isAdmin: member.isAdmin }),
    loadConfig(db),
  ]);
  if (!loan) notFound();

  const party = loan.viewerParty;
  const other = party === "lender" ? loan.borrower : loan.lender;
  const step = nextStep(loan, party, new Date(), config.dispute_window_hours);
  const chatOpen = isChatOpen(loan);
  const canExtend = party === "borrower" && loan.state === "on_loan" && !loan.extended;

  const [cluster] = member.clusterId
    ? await db
        .select({ slug: clusters.slug })
        .from(clusters)
        .where(eq(clusters.id, member.clusterId))
    : [];
  // Suggested public spots only make sense for an in-person meet-up.
  const meetupSpots =
    cluster && loan.handoffMethod === "meetup" ? (config.meetup_spots[cluster.slug] ?? []) : [];

  const photos = await Promise.all(
    loan.photos.map(async (p) => ({
      ...p,
      url: await signedReadUrl(p.storagePath).catch(() => null),
    })),
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex gap-4">
        <BookCover
          src={loan.book.coverUrl}
          title={loan.book.title}
          className="w-20 shrink-0"
          sizes="80px"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <Link href={`/b/${loan.book.id}`} className="leading-tight font-medium hover:underline">
            {loan.book.title}
          </Link>
          <p className="text-muted-foreground text-sm">{loan.book.authors.join(", ")}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ConditionBadge condition={loan.copy.condition} />
            <span className="text-muted-foreground">
              {party === "lender" ? "Lending to" : "Borrowing from"}
            </span>
            <Link href={`/m/${other.id}`} className="hover:underline">
              {other.displayName}
            </Link>
            <TrustScore score={other.trustScore} />
          </div>
          <p className="text-muted-foreground text-xs">
            {loan.rentalPaise === 0 ? "Free loan" : `Rental ${formatPaise(loan.rentalPaise)}`}
            {party === "lender" && loan.rentalPaise > 0
              ? ` · you receive ${formatPaise(loan.rentalPaise - loan.platformFeePaise)}`
              : ""}
            {loan.paidAt ? " · paid" : ""}
          </p>
        </div>
      </header>

      <section className="rounded-lg border p-4">
        <h1 className="text-lg font-semibold">{step.title}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{step.body}</p>
        <div className="mt-4">
          <LoanActions
            loanId={loan.id}
            party={party}
            step={step}
            handoffCode={loan.handoffCode}
            dropPoint={
              loan.dropPoint
                ? {
                    id: loan.dropPoint.id,
                    name: loan.dropPoint.name,
                    address: loan.dropPoint.address,
                  }
                : null
            }
            meetupSpots={meetupSpots}
            canExtend={canExtend}
            rentalPaise={loan.rentalPaise}
          />
        </div>
      </section>

      {loan.dispute && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-medium">Problem reported {when.format(loan.dispute.at)}</p>
          <p className="mt-1">{loan.dispute.reason}</p>
          {loan.dispute.state === "resolved" && (
            <p className="mt-2">
              <span className="font-medium">Decision:</span>{" "}
              {loan.dispute.resolution?.replace("_", " ")}
              {loan.dispute.note && <> · {loan.dispute.note}</>}
            </p>
          )}
        </section>
      )}

      {loan.state !== "requested" && loan.state !== "declined" && loan.state !== "expired" && (
        <LoanChat
          loanId={loan.id}
          meId={member.id}
          open={chatOpen}
          otherName={other.displayName ?? "the other member"}
          initial={loan.messages.map((m) => ({
            id: m.id,
            senderId: m.senderId,
            body: m.body,
            at: m.at.toISOString(),
          }))}
        />
      )}

      {photos.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-sm font-medium">Photos</h2>
          <ul className="grid grid-cols-2 gap-2">
            {photos.map((p) => (
              <li key={p.id} className="overflow-hidden rounded-lg border">
                {p.url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                  <img
                    src={p.url}
                    alt=""
                    className="aspect-[4/3] w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="bg-muted aspect-[4/3]" />
                )}
                <p className="text-muted-foreground p-2 text-xs">
                  {p.phase === "out" ? "Handover" : "Return"} ·{" "}
                  {p.takenBy === loan.lender.id ? "lender" : "borrower"}
                  {p.condition && ` · ${p.condition.replace("_", " ")}`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-sm font-medium">Timeline</h2>
        <ol className="flex flex-col gap-2 border-l pl-4 text-sm">
          {loan.timeline.map((e) => (
            <li key={e.id} className="relative">
              <span className="bg-foreground absolute top-1.5 -left-[21px] size-2 rounded-full" />
              <span>{EVENT_LABEL[e.type] ?? e.type}</span>
              <span className="text-muted-foreground ml-2 text-xs">{when.format(e.at)}</span>
            </li>
          ))}
          {loan.dueAt && ["on_loan", "overdue"].includes(loan.state) && (
            <li className="text-muted-foreground relative">
              <span className="bg-background absolute top-1.5 -left-[21px] size-2 rounded-full border" />
              Due {when.format(loan.dueAt)}
              {loan.extended && " (extended)"}
            </li>
          )}
        </ol>
      </section>
    </div>
  );
}
