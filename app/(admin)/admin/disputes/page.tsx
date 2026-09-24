import Link from "next/link";
import { getDb } from "@/db/client";
import { listOpenDisputes } from "@/lib/admin/loans";
import { formatPaise } from "@/lib/money";
import { when } from "../_components/fmt";
import { ResolveForm } from "./resolve-form";

/** Requirement 13.4: oldest open dispute first, with the resolution form inline. */
export default async function AdminDisputesPage() {
  const rows = await listOpenDisputes(getDb());
  const open = rows.filter((r) => r.state === "open");
  const closed = rows.filter((r) => r.state !== "open");
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Disputes</h1>
      <section className="flex flex-col gap-3">
        <h2 className="text-muted-foreground text-sm font-medium">Open · {open.length}</h2>
        {open.length === 0 && <p className="text-muted-foreground text-sm">Queue is empty.</p>}
        {open.map((d) => (
          <div key={d.id} className="rounded-lg border p-4">
            <p className="font-medium">
              <Link href={`/admin/loans/${d.loanId}`} className="underline">
                {d.title}
              </Link>{" "}
              · opened {when.format(d.createdAt)}
            </p>
            <p className="text-muted-foreground text-sm">
              lender {d.lender} · borrower {d.borrower} · replacement value{" "}
              {formatPaise(d.replacementValuePaise)}
            </p>
            <p className="mt-2 text-sm">{d.reason}</p>
            <p className="text-muted-foreground text-xs">
              <Link href={`/admin/loans/${d.loanId}`} className="underline">
                Compare the handover and return photos
              </Link>{" "}
              before deciding.
            </p>
            <div className="mt-3">
              <ResolveForm disputeId={d.id} maxChargePaise={d.replacementValuePaise} />
            </div>
          </div>
        ))}
      </section>
      {closed.length > 0 && (
        <section>
          <h2 className="text-muted-foreground mb-1 text-sm font-medium">Recently resolved</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {closed.map((d) => (
              <li key={d.id} className="px-3 py-1.5">
                <Link href={`/admin/loans/${d.loanId}`} className="underline">
                  {d.title}
                </Link>{" "}
                · {d.resolution} · {when.format(d.createdAt)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
