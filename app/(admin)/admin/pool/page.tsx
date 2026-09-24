import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { poolRuns } from "@/db/schema";
import { formatPaise } from "@/lib/money";
import { previousMonthUtc } from "@/lib/pool/run";
import { SimpleButton } from "../_components/simple-button";
import { when } from "../_components/fmt";
import { generateBatchAction, runPoolAction } from "../actions";

const monthName = (d: Date) =>
  new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(d);

/** Requirement 13.7 / 10.3: immutable statements, with a manual run for recovery. */
export default async function AdminPoolPage() {
  const runs = await getDb().select().from(poolRuns).orderBy(desc(poolRuns.month));
  const lastMonth = previousMonthUtc(new Date());
  const hasLast = runs.some((r) => r.month.getTime() === lastMonth.getTime());
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between">
        <h1 className="text-2xl font-semibold">Pool runs</h1>
        {!hasLast && (
          <SimpleButton
            label={`Run pool for ${monthName(lastMonth)}`}
            action={() => runPoolAction(lastMonth.toISOString())}
            variant="default"
            size="default"
          />
        )}
      </header>
      {runs.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No runs yet. The monthly job runs on the 1st.
        </p>
      )}
      {runs.map((r) => (
        <section key={r.id} className="rounded-lg border p-4 text-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium">{monthName(r.month)}</h2>
              <p className="text-muted-foreground">run {when.format(r.createdAt)}</p>
            </div>
            <SimpleButton label="Generate payout batch" action={() => generateBatchAction(r.id)} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat k="Revenue" v={formatPaise(r.revenuePaise)} />
            <Stat
              k={`Pool (${r.poolPct}%) + carry in`}
              v={`${formatPaise(r.poolPaise)} (+${formatPaise(r.carryInPaise)})`}
            />
            <Stat k="Completed loans" v={String(r.loanCount)} />
            <Stat
              k="Per loan · carry out"
              v={`${formatPaise(r.perLoanPaise)} · ${formatPaise(r.carryOutPaise)}`}
            />
          </dl>
          <details className="mt-3">
            <summary className="text-muted-foreground cursor-pointer">
              Per-lender credits ({r.statement.lenders.length})
            </summary>
            <ul className="mt-2 divide-y rounded border">
              {r.statement.lenders.map((l) => (
                <li key={l.memberId} className="flex justify-between px-3 py-1">
                  <a href={`/admin/members/${l.memberId}`} className="underline">
                    {l.memberId.slice(0, 8)}
                  </a>
                  <span>
                    {l.loanCount} × {formatPaise(r.perLoanPaise)} = {formatPaise(l.creditPaise)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ))}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
