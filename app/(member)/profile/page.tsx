import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { TrustScore } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { clusters, plans } from "@/db/schema";
import { signOut } from "@/app/(auth)/login/actions";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { checkRefundEligibility } from "@/lib/members/membership";
import { formatPaise } from "@/lib/money";
import { ProfileActions } from "./profile-actions";

export const metadata: Metadata = { title: "Me" };

const STATE_LABEL: Record<string, string> = {
  registered: "Listing only",
  active: "Active",
  lapsed: "Lapsed (payment due)",
  suspended: "Suspended",
  cancelled: "Cancelled",
};

export default async function ProfilePage() {
  const member = await requireOnboardedMember();
  const db = getDb();
  const [config, [cluster], [plan], refund] = await Promise.all([
    loadConfig(db),
    db
      .select({ name: clusters.name, slug: clusters.slug })
      .from(clusters)
      .where(eq(clusters.id, member.clusterId)),
    member.planId
      ? db
          .select({ name: plans.name, pricePaise: plans.pricePaise })
          .from(plans)
          .where(eq(plans.id, member.planId))
      : Promise.resolve([undefined]),
    checkRefundEligibility(db, member.id),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{member.displayName}</h1>
        <p className="text-muted-foreground text-sm">
          <Link href={`/c/${cluster.slug}`} className="hover:underline">
            {cluster.name}
          </Link>{" "}
          · <TrustScore score={member.trustScore} /> ·{" "}
          <Link href={`/m/${member.id}`} className="underline underline-offset-2">
            public shelf
          </Link>
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Membership"
          value={STATE_LABEL[member.state]}
          sub={plan ? `${plan.name} · ${formatPaise(plan.pricePaise)}/month` : "No plan"}
        />
        <Stat
          label="Deposit held"
          value={formatPaise(member.depositBalancePaise)}
          sub={
            member.needsTopup
              ? `Top up to ${formatPaise(config.deposit_paise)} to borrow`
              : `Required ${formatPaise(config.deposit_paise)}`
          }
        />
        <Stat
          label="Payout balance"
          value={formatPaise(member.payoutBalancePaise)}
          sub={
            <Link href="/earnings" className="underline">
              Earnings
            </Link>
          }
        />
      </section>

      {member.state === "registered" && (
        <Button render={<Link href="/activate" />}>Start borrowing</Button>
      )}
      {member.needsTopup && member.state !== "registered" && (
        <Button render={<Link href="/activate" />}>Top up deposit</Button>
      )}

      <ProfileActions
        displayName={member.displayName}
        hasPlan={
          Boolean(member.razorpaySubscriptionId) &&
          (member.state === "active" || member.state === "lapsed")
        }
        refund={
          refund.ok
            ? { eligible: true, amountPaise: refund.amountPaise }
            : { eligible: false, reason: refund.reason }
        }
        depositPaise={member.depositBalancePaise}
        payoutPaise={member.payoutBalancePaise}
        payoutThresholdPaise={config.payout_threshold_paise}
      />

      <form action={signOut}>
        <Button variant="ghost" type="submit">
          Sign out
        </Button>
      </form>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {sub && <p className="text-muted-foreground text-xs">{sub}</p>}
    </div>
  );
}
