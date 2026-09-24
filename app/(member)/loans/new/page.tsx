import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ConditionBadge, TrustScore } from "@/components/badges";
import { BookCover } from "@/components/book-cover";
import { getDb } from "@/db/client";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { decideRequestGate } from "@/lib/loans/request-gate";
import { loadRequestPage } from "@/lib/loans/request-page";
import { formatPaise } from "@/lib/money";
import { RequestForm } from "./request-form";

export const metadata: Metadata = { title: "Request a book" };

export default async function NewLoanPage({
  searchParams,
}: {
  searchParams: Promise<{ copy?: string }>;
}) {
  const { copy: copyId } = await searchParams;
  if (!copyId) notFound();
  const member = await requireOnboardedMember();
  const db = getDb();
  const [data, config] = await Promise.all([loadRequestPage(db, copyId), loadConfig(db)]);
  if (!data) notFound();

  // Same gate as the book page; anyone arriving here through a stale link gets routed properly.
  const gate = decideRequestGate(
    {
      signedIn: true,
      onboarded: true,
      memberId: member.id,
      clusterId: member.clusterId,
      trustScore: member.trustScore,
      state: member.state,
    },
    {
      id: data.copy.id,
      ownerId: data.copy.ownerId,
      clusterId: data.copy.clusterId,
      availability: data.copy.availability === "available" ? "available" : "on_loan",
      minBorrowerTrust: 0,
    },
    config.borrow_gate.min_trust_score,
  );
  if (gate.kind === "blocked" && gate.reason === "needs_activation")
    redirect(`/activate?return=${encodeURIComponent(`/loans/new?copy=${copyId}`)}`);
  if (gate.kind !== "request") redirect(`/b/${data.book.id}`);

  const methods = data.copy.allowedHandoffs.filter(
    (h): h is "meetup" | "courier" => h === "meetup" || h === "courier",
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Request this book</h1>
      <div className="flex gap-4 rounded-lg border p-3">
        <BookCover
          src={data.book.coverUrl}
          title={data.book.title}
          className="w-16 shrink-0"
          sizes="64px"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="leading-tight font-medium">{data.book.title}</p>
          <p className="text-muted-foreground text-sm">{data.book.authors.join(", ")}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ConditionBadge condition={data.copy.condition} />
            <Link href={`/m/${data.lender.id}`} className="hover:underline">
              {data.lender.displayName}
            </Link>
            <TrustScore score={data.lender.trustScore} />
          </div>
          <p className="text-sm font-medium">
            {data.copy.rentalPricePaise === 0
              ? "Free to borrow"
              : `${formatPaise(data.copy.rentalPricePaise)} for ${data.copy.loanPeriodDays} days`}
          </p>
          <p className="text-muted-foreground text-xs">
            Replacement value {formatPaise(data.copy.replacementValuePaise)} if lost
          </p>
        </div>
      </div>
      <RequestForm copyId={data.copy.id} methods={methods} />
    </div>
  );
}
