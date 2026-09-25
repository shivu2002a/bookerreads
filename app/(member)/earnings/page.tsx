import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { loadEarnings } from "@/lib/earnings/dashboard";
import { formatPaise } from "@/lib/money";
import { UpiForm } from "./upi-form";

export const metadata: Metadata = { title: "Earnings" };

const monthName = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(new Date(iso));
const shortDate = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

export default async function EarningsPage() {
  const member = await requireOnboardedMember();
  const db = getDb();
  const e = await loadEarnings(db, member, await loadConfig(db));
  const progress = Math.min(100, Math.round((e.balancePaise / e.thresholdPaise) * 100));

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
        <p className="text-muted-foreground text-sm">
          You set the price on each copy. When a book goes out, the rental less the{" "}
          {e.platformFeePct}% platform fee is credited to your balance, and balances are paid out
          monthly by UPI.
        </p>
      </header>

      <section className="rounded-lg border p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-muted-foreground text-sm">Balance</p>
          <p className="text-2xl font-semibold">{formatPaise(e.balancePaise)}</p>
        </div>
        <div className="bg-muted mt-3 h-2 overflow-hidden rounded">
          <div className="bg-foreground h-full" style={{ width: `${progress}%` }} />
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          {e.balancePaise >= e.thresholdPaise
            ? `Above the ${formatPaise(e.thresholdPaise)} minimum. Paid out on ${shortDate.format(e.nextPayoutDate)}${e.upi.verified ? "." : " once your UPI ID is verified."}`
            : `${formatPaise(e.thresholdPaise - e.balancePaise)} more to reach the ${formatPaise(e.thresholdPaise)} payout minimum. Balances roll over.`}
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <Stat
          label={`Earned in ${monthName(`${e.thisMonth.month}-01`).split(" ")[0]}`}
          value={formatPaise(e.thisMonth.earnedPaise)}
          sub={
            e.thisMonth.loans
              ? `${e.thisMonth.loans} loan${e.thisMonth.loans === 1 ? "" : "s"} went out`
              : "No loans out yet this month"
          }
        />
        <Stat label="Earned all time" value={formatPaise(e.allTimePaise)} />
        <Stat
          label="Next payout"
          value={shortDate.format(e.nextPayoutDate)}
          sub="1st of every month"
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-sm font-medium">Payout UPI ID</h2>
        <UpiForm current={e.upi.id} verified={e.upi.verified} />
      </section>

      {e.mostRequested.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-sm font-medium">Most requested (90 days)</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {e.mostRequested.map((c) => (
              <li key={c.copyId} className="flex justify-between p-3">
                <span className="truncate">{c.title}</span>
                <span className="text-muted-foreground">{c.requests}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {e.idle.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-sm font-medium">No requests in 90 days</h2>
          <p className="text-muted-foreground text-xs">
            These aren&apos;t earning. Consider unlisting them from your{" "}
            <Link href="/shelf" className="underline">
              shelf
            </Link>{" "}
            to keep it fresh.
          </p>
          <ul className="divide-y rounded-lg border text-sm">
            {e.idle.map((c) => (
              <li key={c.copyId} className="flex justify-between p-3">
                <span className="truncate">{c.title}</span>
                <span className="text-muted-foreground">{c.listedDays}d</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {e.recentCredits.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-sm font-medium">Recent activity</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {e.recentCredits.map((c) => (
              <li key={c.id} className="flex justify-between gap-3 p-3">
                <span className="truncate">{c.note ?? c.kind.replace(/_/g, " ")}</span>
                <span className={c.amountPaise < 0 ? "text-muted-foreground" : "font-medium"}>
                  {c.amountPaise > 0 ? "+" : ""}
                  {formatPaise(c.amountPaise)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {sub && <p className="text-muted-foreground text-xs">{sub}</p>}
    </div>
  );
}
