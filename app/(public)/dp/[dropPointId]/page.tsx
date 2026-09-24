import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { getCurrentMember } from "@/lib/auth/current-member";
import { loadDropPointPage } from "@/lib/loans/drop-point-page";
import { DropPointCodeEntry } from "./code-entry";

export const metadata: Metadata = { title: "Drop point" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ dropPointId: string }>; searchParams: Promise<{ s?: string }> };

/**
 * Scanned from the poster at the venue. Verifies the QR secret, then shows the
 * viewer's pending drop or collect for this venue with a code box.
 */
export default async function DropPointPage({ params, searchParams }: Props) {
  const [{ dropPointId }, { s }] = await Promise.all([params, searchParams]);
  const member = await getCurrentMember();
  const page = await loadDropPointPage(getDb(), dropPointId, s, member?.id ?? null);
  if (!page) notFound();

  const here = `/dp/${dropPointId}${s ? `?s=${encodeURIComponent(s)}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-muted-foreground text-xs tracking-wide uppercase">Drop point</p>
        <h1 className="text-2xl font-semibold tracking-tight">{page.dropPoint.name}</h1>
        <p className="text-muted-foreground text-sm">{page.dropPoint.address}</p>
      </header>

      {!page.verified ? (
        <div className="rounded-lg border p-4 text-sm">
          <p className="font-medium">This QR code is out of date</p>
          <p className="text-muted-foreground mt-1">
            Ask the venue for the current poster, or enter your code from the loan page instead.
          </p>
        </div>
      ) : !member ? (
        <div className="flex flex-col gap-3 rounded-lg border p-4 text-sm">
          <p>Sign in to drop off or collect a book here.</p>
          <Button render={<Link href={`/login?next=${encodeURIComponent(here)}`} />}>
            Sign in
          </Button>
        </div>
      ) : page.actions.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border p-4 text-sm">
          Nothing for you to drop or collect at this venue right now.{" "}
          <Link href="/requests" className="underline">
            See your loans
          </Link>
          .
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {page.actions.map((a) => (
            <li key={`${a.loanId}-${a.phase}`} className="rounded-lg border p-4">
              <p className="font-medium">{a.bookTitle}</p>
              <p className="text-muted-foreground mb-3 text-sm">
                {a.action === "drop"
                  ? "Leave the book on the shelf, then enter your handoff code."
                  : "Take the book from the shelf, then enter your handoff code."}
              </p>
              <DropPointCodeEntry
                loanId={a.loanId}
                action={a.action}
                phase={a.phase}
                isLender={a.phase === "out" ? a.action === "drop" : a.action === "collect"}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
