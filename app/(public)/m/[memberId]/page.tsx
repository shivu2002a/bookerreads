import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConditionBadge, TrustScore, VerifiedBadge } from "@/components/badges";
import { BookCover } from "@/components/book-cover";
import { getDb } from "@/db/client";
import { getPublicProfile } from "@/lib/members/public-profile";
import { listingPhotoUrl } from "@/lib/photos/url";

type Params = { params: Promise<{ memberId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { memberId } = await params;
  const profile = await getPublicProfile(getDb(), memberId);
  return { title: profile ? `${profile.displayName}'s shelf` : "Member" };
}

const monthYear = new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" });

/**
 * Requirement 3.5: display name, cluster, trust score, member-since, acceptance
 * rate, available copies. Never phone or address.
 */
export default async function PublicShelfPage({ params }: Params) {
  const { memberId } = await params;
  const profile = await getPublicProfile(getDb(), memberId);
  if (!profile) notFound();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{profile.displayName}</h1>
        <p className="text-muted-foreground text-sm">
          {profile.cluster ? (
            <Link href={`/c/${profile.cluster.slug}`} className="hover:underline">
              {profile.cluster.name}
            </Link>
          ) : (
            "No home area yet"
          )}{" "}
          · member since {monthYear.format(profile.memberSince)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
          <TrustScore score={profile.trustScore} />
          <span>
            {profile.acceptanceRate === null ? (
              <span className="text-muted-foreground">New lender</span>
            ) : (
              <>
                <span className="font-medium tabular-nums">
                  {Math.round(profile.acceptanceRate * 100)}%
                </span>{" "}
                <span className="text-muted-foreground">accepts requests</span>
              </>
            )}
          </span>
          <span>
            <span className="font-medium tabular-nums">{profile.completedLends}</span>{" "}
            <span className="text-muted-foreground">books lent</span>
          </span>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-muted-foreground text-sm font-medium">
          On the shelf · {profile.copies.length}
        </h2>
        {profile.copies.length === 0 ? (
          <p className="text-muted-foreground text-sm">No books listed right now.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {profile.copies.map((c) => (
              <li key={c.id}>
                <Link href={`/b/${c.book.id}`} className="flex flex-col gap-1.5">
                  <BookCover
                    src={c.book.coverUrl ?? listingPhotoUrl(c.listingPhotoPath)}
                    title={c.book.title}
                    sizes="(max-width: 640px) 33vw, 160px"
                  />
                  <span className="line-clamp-2 text-xs leading-tight font-medium">
                    {c.book.title}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    <ConditionBadge condition={c.condition} />
                    <VerifiedBadge status={c.verificationStatus} />
                    {c.availability === "on_loan" && (
                      <span className="text-muted-foreground text-[10px]">On loan</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
