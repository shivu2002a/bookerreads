import Link from "next/link";
import { getDb } from "@/db/client";
import { formatPaise } from "@/lib/money";
import { listBatch, listBatches } from "@/lib/payouts/batch";
import { ActionForm, Field, ReasonField } from "../_components/action-form";
import { when } from "../_components/fmt";
import { SimpleButton } from "../_components/simple-button";
import { generateBatchAction, markExportedAction, payoutResultAction } from "../actions";

/** Requirement 10.5 / 13.7: export the CSV, upload to RazorpayX, record each result. */
export default async function AdminPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string }>;
}) {
  const { batch } = await searchParams;
  const db = getDb();
  const batches = await listBatches(db);
  const selected = batch ?? batches[0]?.batchId;
  const rows = selected ? await listBatch(db, selected) : [];
  const thisMonth = new Date().toISOString().slice(0, 7);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Payouts</h1>
        <SimpleButton
          label={`Generate ${thisMonth} batch`}
          action={() => generateBatchAction(`${thisMonth}-01`)}
        />
      </div>
      <p className="text-muted-foreground text-sm">
        Lenders at or above the payout minimum with a verified UPI ID. The monthly cron generates
        the batch on the 1st; the button is for a manual run.
      </p>
      <div className="flex flex-wrap gap-2 text-sm">
        {batches.map((b) => (
          <Link
            key={b.batchId}
            href={`/admin/payouts?batch=${b.batchId}`}
            className={`rounded-md border px-3 py-1 ${b.batchId === selected ? "bg-muted" : ""}`}
          >
            {b.batchId} · {Number(b.count)} · {formatPaise(Number(b.totalPaise))}{" "}
            {Number(b.pending) > 0 && (
              <span className="text-amber-700">· {Number(b.pending)} open</span>
            )}
          </Link>
        ))}
        {batches.length === 0 && <p className="text-muted-foreground">No batches yet.</p>}
      </div>

      {selected && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <a
              href={`/api/admin/payouts/${selected}.csv`}
              className="h-8 rounded-md border px-3 text-sm leading-8"
            >
              Download RazorpayX CSV
            </a>
            <SimpleButton label="Mark batch exported" action={() => markExportedAction(selected)} />
          </div>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left">
              <tr>
                <th className="py-1">Member</th>
                <th>UPI</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Record result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t align-top">
                  <td className="py-1.5">
                    <Link href={`/admin/members/${p.memberId}`} className="underline">
                      {p.memberId.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{p.upiId}</td>
                  <td>{formatPaise(p.amountPaise)}</td>
                  <td>
                    {p.status}
                    {p.razorpayPayoutId && (
                      <span className="text-muted-foreground block text-xs">
                        {p.razorpayPayoutId}
                      </span>
                    )}
                    {p.failureReason && (
                      <span className="text-destructive block text-xs">{p.failureReason}</span>
                    )}
                  </td>
                  <td>{when.format(p.updatedAt)}</td>
                  <td>
                    {(p.status === "pending" || p.status === "exported") && (
                      <ActionForm
                        action={payoutResultAction}
                        submitLabel="Record"
                        className="flex flex-wrap items-end gap-1"
                      >
                        <input type="hidden" name="payoutId" value={p.id} />
                        <select
                          name="result"
                          className="bg-background h-8 rounded border px-1 text-xs"
                        >
                          <option value="paid">paid</option>
                          <option value="failed">failed</option>
                        </select>
                        <Field name="razorpayPayoutId" label="RazorpayX id" />
                        <Field name="failureReason" label="Failure reason" />
                        <ReasonField label="Note" />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
