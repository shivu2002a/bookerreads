import { getDb } from "@/db/client";
import { clusters } from "@/db/schema";
import { clusterHealth } from "@/lib/admin/health";
import { formatPaise } from "@/lib/money";
import { pct, when } from "../_components/fmt";
import { SimpleButton } from "../_components/simple-button";
import { openClusterAction } from "../actions";

/** Requirement 13.5. */
export default async function AdminHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { c } = await searchParams;
  const db = getDb();
  const all = await db.select().from(clusters).orderBy(clusters.name);
  const cluster = all.find((x) => x.slug === c) ?? all.find((x) => x.status === "open") ?? all[0];
  const h = cluster ? await clusterHealth(db, cluster.id) : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Cluster health</h1>
        <nav className="flex gap-2 text-sm">
          {all.map((x) => (
            <a
              key={x.id}
              href={`/admin/health?c=${x.slug}`}
              className={`rounded-md border px-3 py-1 ${x.id === cluster?.id ? "bg-muted" : ""}`}
            >
              {x.name} <span className="text-muted-foreground">· {x.status}</span>
            </a>
          ))}
        </nav>
        {cluster && cluster.status === "waitlist" && (
          <SimpleButton
            label="Open this cluster"
            action={(r) => openClusterAction(cluster.id, r)}
            promptReason="Why open now? Waitlisted members will be notified."
            variant="default"
          />
        )}
      </header>

      {h && (
        <>
          <section className="grid gap-3 md:grid-cols-4">
            <Card title="Requests this month" value={String(h.requestsThisMonth)} />
            <Card title="Fill rate" value={pct(h.fillRate)} sub="requests that reached handoff" />
            <Card
              title="Median request → handoff"
              value={
                h.medianRequestToHandoffHours === null
                  ? "—"
                  : `${h.medianRequestToHandoffHours.toFixed(1)} h`
              }
              sub="last 90 days"
            />
            <Card title="On-time return rate" value={pct(h.onTimeReturnRate)} sub="last 90 days" />
            <Card
              title="Deposit liability"
              value={formatPaise(h.depositLiabilityPaise)}
              sub="held, owed back to members; never netted against revenue"
            />
            <Card
              title="Payout liability"
              value={formatPaise(h.payoutLiabilityPaise)}
              sub="earned, not yet paid"
            />
          </section>
          <section className="grid gap-4 md:grid-cols-3">
            <Breakdown title="Members by state" data={h.membersByState} />
            <Breakdown title="Copies by availability" data={h.copiesByAvailability} />
            <Breakdown title="Copies by verification" data={h.copiesByVerification} />
          </section>
          <section>
            <h2 className="text-muted-foreground mb-1 text-sm font-medium">
              Recent scheduled jobs
            </h2>
            <ul className="divide-y rounded-lg border text-sm">
              {h.recentCronRuns.map((r) => {
                const failed = r.steps.filter((s) => !s.ok);
                return (
                  <li key={r.id} className="px-3 py-1.5">
                    <span className="font-medium">{r.job}</span> · {when.format(r.startedAt)} ·{" "}
                    {r.steps.length} steps
                    {failed.length ? (
                      <span className="text-destructive">
                        {" "}
                        · {failed.length} failed: {failed.map((f) => f.step).join(", ")}
                      </span>
                    ) : (
                      <span className="text-muted-foreground"> · ok</span>
                    )}
                    {!r.finishedAt && (
                      <span className="text-amber-700"> · still running or crashed</span>
                    )}
                  </li>
                );
              })}
              {h.recentCronRuns.length === 0 && (
                <li className="text-muted-foreground px-3 py-1.5">No runs yet.</li>
              )}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function Card({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{title}</p>
      <p className="text-xl font-semibold">{value}</p>
      {sub && <p className="text-muted-foreground text-xs">{sub}</p>}
    </div>
  );
}

function Breakdown({ title, data }: { title: string; data: Record<string, number> }) {
  return (
    <div className="rounded-lg border p-3 text-sm">
      <p className="text-muted-foreground mb-1 text-xs">{title}</p>
      <ul>
        {Object.entries(data)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => (
            <li key={k} className="flex justify-between">
              <span>{k}</span>
              <span className="font-medium">{v}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
