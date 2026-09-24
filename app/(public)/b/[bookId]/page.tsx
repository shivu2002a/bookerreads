import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ConditionBadge, TrustScore, VerifiedBadge } from "@/components/badges";
import { BookCover } from "@/components/book-cover";
import { ClusterSwitcher } from "@/components/cluster-switcher";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { loadConfig } from "@/lib/config/load";
import { decideRequestGate, type GateDecision } from "@/lib/loans/request-gate";
import { formatPaise } from "@/lib/money";
import { getBookPage, type BookPageCopy } from "@/lib/search/queries";
import { resolveViewerContext } from "@/lib/search/viewer-cluster";

type Props = { params: Promise<{ bookId: string }>; searchParams: Promise<{ c?: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { bookId } = await params;
  const page = await getBookPage(getDb(), bookId, null);
  return { title: page?.book.title ?? "Book" };
}

const HANDOFF_LABEL = { meetup: "Meet-up", drop_point: "Drop point", courier: "Porter" } as const;

export default async function BookPage({ params, searchParams }: Props) {
  const [{ bookId }, { c }] = await Promise.all([params, searchParams]);
  const db = getDb();
  const ctx = await resolveViewerContext(c);
  const page = await getBookPage(db, bookId, ctx.cluster?.id ?? null);
  if (!page) notFound();
  if (page.book.mergedIntoId) redirect(`/b/${page.book.mergedIntoId}${c ? `?c=${c}` : ""}`);

  const config = await loadConfig(db);
  const viewer = {
    signedIn: ctx.signedIn,
    onboarded: ctx.onboarded,
    memberId: ctx.member?.id ?? null,
    clusterId: ctx.member?.clusterId ?? null,
    trustScore: ctx.member?.trustScore ?? null,
    state: ctx.member?.state ?? null,
  };
  const { book } = page;
  const available = page.copies.filter((cp) => cp.availability === "available").length;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex gap-4">
        <BookCover
          src={book.coverUrl}
          title={book.title}
          className="w-28 shrink-0"
          sizes="112px"
          priority
        />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl leading-tight font-semibold tracking-tight">{book.title}</h1>
          <p className="text-muted-foreground text-sm">{book.authors.join(", ")}</p>
          <p className="text-muted-foreground text-xs">
            {[book.publisher, book.publishedYear, book.pageCount ? `${book.pageCount} pages` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {book.isbn13 && (
            <p className="text-muted-foreground font-mono text-xs">ISBN {book.isbn13}</p>
          )}
          {book.needsReview && (
            <p className="text-xs text-amber-700">Catalogue details pending review</p>
          )}
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-medium">
            {ctx.cluster ? (
              <>
                {available} available in {ctx.cluster.name}
                {page.copies.length > available && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {page.copies.length - available} on loan
                  </span>
                )}
              </>
            ) : (
              "No open areas yet"
            )}
          </h2>
          {ctx.cluster && !ctx.member?.clusterId && (
            <ClusterSwitcher current={ctx.cluster.slug} clusters={ctx.openClusters} />
          )}
        </div>

        {page.copies.length === 0 ? (
          <div className="text-muted-foreground rounded-lg border p-4 text-sm">
            Nobody in this area has listed a copy yet.
            {page.listedElsewhere > 0 && <> {page.listedElsewhere} listed in other areas.</>}{" "}
            {ctx.onboarded ? (
              <>
                Own one?{" "}
                <Link href="/shelf/add" className="underline">
                  List it
                </Link>
                .
              </>
            ) : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {page.copies.map((cp) => (
              <CopyRow
                key={cp.id}
                copy={cp}
                signedIn={ctx.signedIn}
                decision={decideRequestGate(
                  viewer,
                  {
                    id: cp.id,
                    ownerId: cp.lender.id,
                    clusterId: ctx.cluster!.id,
                    availability: cp.availability,
                    minBorrowerTrust: cp.minBorrowerTrust,
                  },
                  config.borrow_gate.min_trust_score,
                )}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CopyRow({
  copy,
  signedIn,
  decision,
}: {
  copy: BookPageCopy;
  signedIn: boolean;
  decision: GateDecision;
}) {
  if (decision.kind === "hidden") return null;
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <ConditionBadge condition={copy.condition} />
        <VerifiedBadge status={copy.verificationStatus} />
        {copy.availability === "on_loan" && (
          <span className="text-muted-foreground text-xs">On loan</span>
        )}
        <span className="text-muted-foreground ml-auto text-xs">
          {copy.allowedHandoffs.map((h) => HANDOFF_LABEL[h]).join(" · ")}
        </span>
      </div>
      {copy.notes && <p className="text-sm">{copy.notes}</p>}
      <div className="flex items-center justify-between gap-3">
        {signedIn ? (
          <Link href={`/m/${copy.lender.id}`} className="flex flex-col text-sm hover:underline">
            <span className="font-medium">{copy.lender.displayName}</span>
            <span className="text-muted-foreground flex gap-2 text-xs">
              <TrustScore score={copy.lender.trustScore} />
              {copy.lender.acceptanceRate !== null && (
                <span>{Math.round(copy.lender.acceptanceRate * 100)}% accepts</span>
              )}
            </span>
          </Link>
        ) : (
          <span className="text-muted-foreground text-sm">Sign in to see the lender</span>
        )}
        <RequestCta copyId={copy.id} decision={decision} />
      </div>
      <p className="text-muted-foreground text-xs">
        Replacement value {formatPaise(copy.replacementValuePaise)}
      </p>
    </li>
  );
}

function RequestCta({ copyId, decision }: { copyId: string; decision: GateDecision }) {
  switch (decision.kind) {
    case "request":
      return <Button render={<Link href={`/loans/new?copy=${copyId}`} />}>Request</Button>;
    case "sign_in":
      return (
        <Button
          variant="outline"
          render={<Link href={`/login?next=${encodeURIComponent(`/loans/new?copy=${copyId}`)}`} />}
        >
          Sign in to request
        </Button>
      );
    case "onboard":
      return (
        <Button variant="outline" render={<Link href="/onboarding" />}>
          Finish setup
        </Button>
      );
    case "blocked":
      return (
        <div className="flex flex-col items-end gap-1">
          {decision.reason === "needs_activation" ? (
            <Button
              variant="outline"
              render={
                <Link
                  href={`/activate?return=${encodeURIComponent(`/loans/new?copy=${copyId}`)}`}
                />
              }
            >
              Activate to request
            </Button>
          ) : (
            <Button disabled>Request</Button>
          )}
          <span className="text-muted-foreground max-w-[12rem] text-right text-xs">
            {decision.hint}
          </span>
        </div>
      );
    case "hidden":
      return null;
  }
}
