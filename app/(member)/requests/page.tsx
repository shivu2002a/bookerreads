import type { Metadata } from "next";
import Link from "next/link";
import { BookCover } from "@/components/book-cover";
import { getDb } from "@/db/client";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { listIncoming, listOutgoing, OPEN_STATES, type LoanListItem } from "@/lib/loans/queries";
import { RequestResponder } from "./request-responder";

export const metadata: Metadata = { title: "Requests" };

const STATE_LABEL: Record<string, string> = {
  requested: "Waiting for reply",
  accepted: "Accepted · arrange handoff",
  on_loan: "On loan",
  overdue: "Overdue",
  returned: "Returned",
  declined: "Declined",
  expired: "Expired",
  lost: "Lost",
  disputed: "In dispute",
  resolved: "Resolved",
};

const HANDOFF_LABEL: Record<LoanListItem["handoffMethod"], string> = {
  meetup: "meet-up",
  courier: "Porter",
  drop_point: "drop point",
};

const relative = (d: Date) => {
  const h = Math.round((Date.now() - d.getTime()) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

export default async function RequestsPage() {
  const member = await requireOnboardedMember();
  const db = getDb();
  const [incoming, outgoing] = await Promise.all([
    listIncoming(db, member.id),
    listOutgoing(db, member.id),
  ]);
  const openIncoming = incoming.filter((l) => l.state === "requested");
  const activeIncoming = incoming.filter(
    (l) => OPEN_STATES.includes(l.state) && l.state !== "requested",
  );
  const activeOutgoing = outgoing.filter((l) => OPEN_STATES.includes(l.state));
  const history = [...incoming, ...outgoing]
    .filter((l) => !OPEN_STATES.includes(l.state))
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
    .slice(0, 20);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold tracking-tight">Requests</h1>

      <Section
        title={`Requests for your books · ${openIncoming.length}`}
        empty="No one is waiting on you."
      >
        {openIncoming.map((l) => (
          <li key={l.id} className="flex flex-col gap-3 rounded-lg border p-3">
            <LoanRow loan={l} who="borrower" />
            <RequestResponder loanId={l.id} />
          </li>
        ))}
      </Section>

      <Section
        title={`Books you're lending · ${activeIncoming.length}`}
        empty="Nothing out right now."
      >
        {activeIncoming.map((l) => (
          <li key={l.id}>
            <Link href={`/loans/${l.id}`} className="hover:bg-muted/50 block rounded-lg border p-3">
              <LoanRow loan={l} who="borrower" />
            </Link>
          </li>
        ))}
      </Section>

      <Section
        title={`Books you're borrowing · ${activeOutgoing.length}`}
        empty="Find something to read in Search."
      >
        {activeOutgoing.map((l) => (
          <li key={l.id}>
            <Link href={`/loans/${l.id}`} className="hover:bg-muted/50 block rounded-lg border p-3">
              <LoanRow loan={l} who="lender" />
            </Link>
          </li>
        ))}
      </Section>

      {history.length > 0 && (
        <Section title="History" empty="">
          {history.map((l) => (
            <li key={l.id}>
              <Link
                href={`/loans/${l.id}`}
                className="hover:bg-muted/50 block rounded-lg border p-3 opacity-80"
              >
                <LoanRow loan={l} who={l.lender.id === member.id ? "borrower" : "lender"} />
              </Link>
            </li>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-muted-foreground text-sm font-medium">{title}</h2>
      {children.length ? (
        <ul className="flex flex-col gap-3">{children}</ul>
      ) : (
        <p className="text-muted-foreground text-sm">{empty}</p>
      )}
    </section>
  );
}

function LoanRow({ loan, who }: { loan: LoanListItem; who: "lender" | "borrower" }) {
  const person = who === "lender" ? loan.lender : loan.borrower;
  return (
    <div className="flex gap-3">
      <BookCover
        src={loan.book.coverUrl}
        title={loan.book.title}
        className="w-12 shrink-0"
        sizes="48px"
      />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 leading-tight font-medium">{loan.book.title}</p>
        <p className="text-muted-foreground text-sm">
          {who === "lender" ? "from" : "for"}{" "}
          <span className="text-foreground">{person.displayName}</span> · {person.trustScore} trust
          {who === "borrower" &&
            ` · ${loan.borrower.onTimeReturns} on-time return${loan.borrower.onTimeReturns === 1 ? "" : "s"}`}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {STATE_LABEL[loan.state]} · {HANDOFF_LABEL[loan.handoffMethod]} ·{" "}
          {relative(loan.requestedAt)}
          {loan.dueAt &&
            OPEN_STATES.includes(loan.state) &&
            loan.state !== "requested" &&
            loan.state !== "accepted" && (
              <>
                {" "}
                · due{" "}
                {new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(
                  loan.dueAt,
                )}
              </>
            )}
        </p>
      </div>
    </div>
  );
}
