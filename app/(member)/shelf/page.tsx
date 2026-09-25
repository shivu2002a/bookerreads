import type { Metadata } from "next";
import Link from "next/link";
import { AvailabilityBadge, ConditionBadge, VerifiedBadge } from "@/components/badges";
import { BookCover } from "@/components/book-cover";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { listShelf, type ShelfCopy } from "@/lib/copies/manage";
import { remainingListingAllowance } from "@/lib/copies/rules";
import { formatPaise } from "@/lib/money";
import { listingPhotoUrl } from "@/lib/photos/url";
import { ShelfCopyActions } from "./shelf-copy-actions";

export const metadata: Metadata = { title: "My shelf" };

const GROUPS: Array<{ key: ShelfCopy["availability"][]; title: string }> = [
  { key: ["requested", "on_loan"], title: "Out or requested" },
  { key: ["available"], title: "Available" },
  { key: ["unlisted"], title: "Unlisted" },
  { key: ["lost"], title: "Lost" },
];

export default async function ShelfPage() {
  const member = await requireOnboardedMember();
  const db = getDb();
  const [shelf, config] = await Promise.all([listShelf(db, member.id), loadConfig(db)]);
  const listed = shelf.filter((c) => c.availability !== "lost").length;
  const allowance = remainingListingAllowance({
    memberCreatedAt: member.createdAt,
    now: new Date(),
    currentCopyCount: listed,
    newAccountAgeDays: config.new_account_age_days,
    cap: config.new_account_listing_cap,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">My shelf</h1>
        <Button render={<Link href="/shelf/add" />}>Add a book</Button>
      </div>

      {Number.isFinite(allowance) && (
        <p className="bg-muted rounded-md px-3 py-2 text-sm">
          New account: {allowance} of {config.new_account_listing_cap} listings left for your first{" "}
          {config.new_account_age_days} days.
        </p>
      )}

      {shelf.length === 0 ? (
        <div className="rounded-lg border p-6 text-center">
          <p className="font-medium">Nothing here yet</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Scan the barcode on any book you own to list it. Listing is free, you set the price, and
            you earn it every time the book goes out.
          </p>
          <Button className="mt-4" render={<Link href="/shelf/add" />}>
            Scan your first book
          </Button>
        </div>
      ) : (
        GROUPS.map((g) => {
          const items = shelf.filter((c) => g.key.includes(c.availability));
          if (!items.length) return null;
          return (
            <section key={g.title} className="flex flex-col gap-3">
              <h2 className="text-muted-foreground text-sm font-medium">
                {g.title} · {items.length}
              </h2>
              <ul className="flex flex-col gap-3">
                {items.map((c) => (
                  <li key={c.id} className="flex gap-3 rounded-lg border p-3">
                    <BookCover
                      src={c.book.coverUrl ?? listingPhotoUrl(c.listingPhotoPath)}
                      title={c.book.title}
                      className="w-14 shrink-0"
                      sizes="56px"
                    />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/b/${c.book.id}`}
                        className="line-clamp-2 leading-tight font-medium hover:underline"
                      >
                        {c.book.title}
                      </Link>
                      <p className="text-muted-foreground truncate text-sm">
                        {c.book.authors.join(", ")}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <AvailabilityBadge availability={c.availability} />
                        <ConditionBadge condition={c.condition} />
                        <VerifiedBadge status={c.verificationStatus} />
                        {c.book.needsReview && (
                          <span className="text-xs text-amber-700">Pending catalogue check</span>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {c.rentalPricePaise === 0
                          ? "Free"
                          : `${formatPaise(c.rentalPricePaise)} per loan`}{" "}
                        · {c.loanPeriodDays} days · {c.requestCount} request
                        {c.requestCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <ShelfCopyActions copyId={c.id} availability={c.availability} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
