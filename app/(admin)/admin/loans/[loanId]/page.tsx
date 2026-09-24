import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/current-member";
import { getLoanForViewer } from "@/lib/loans/queries";
import { LOAN_STATES } from "@/lib/loans/types";
import { signedReadUrl } from "@/lib/photos/storage";
import { ActionForm, ReasonField } from "../../_components/action-form";
import { when } from "../../_components/fmt";
import { overrideLoanAction } from "../../actions";

/** Requirement 13.3: full timeline with photos and confirmations; state override with a reason. */
export default async function AdminLoanPage({ params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params;
  const admin = await requireAdmin();
  const loan = await getLoanForViewer(getDb(), loanId, { id: admin.id, isAdmin: true });
  if (!loan) notFound();
  const photos = await Promise.all(
    loan.photos.map(async (p) => ({
      ...p,
      url: await signedReadUrl(p.storagePath).catch(() => null),
    })),
  );

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">{loan.book.title}</h1>
        <p className="text-muted-foreground text-sm">
          <span className="text-foreground font-medium">{loan.state}</span> · {loan.handoffMethod} ·
          lender{" "}
          <Link href={`/admin/members/${loan.lender.id}`} className="underline">
            {loan.lender.displayName}
          </Link>{" "}
          · borrower{" "}
          <Link href={`/admin/members/${loan.borrower.id}`} className="underline">
            {loan.borrower.displayName}
          </Link>
          {loan.dropPoint && (
            <>
              {" "}
              · {loan.dropPoint.name} · code {loan.handoffCode}
            </>
          )}
        </p>
        <p className="text-muted-foreground text-xs">
          Requested {when.format(loan.requestedAt)}
          {loan.dueAt && (
            <>
              {" "}
              · due {when.format(loan.dueAt)}
              {loan.extended && " (extended)"}
            </>
          )}
          {loan.returnedAt && (
            <>
              {" "}
              · returned {when.format(loan.returnedAt)} as {loan.returnCondition}
            </>
          )}
          {loan.autoConfirmedSide && <> · auto-confirmed for {loan.autoConfirmedSide}</>}
        </p>
      </header>

      <section className="grid gap-2 text-sm md:grid-cols-4">
        <Conf label="Out: lender" at={loan.outLenderConfirmedAt} />
        <Conf label="Out: borrower" at={loan.outBorrowerConfirmedAt} />
        <Conf label="Return: borrower" at={loan.returnBorrowerConfirmedAt} />
        <Conf label="Return: lender" at={loan.returnLenderConfirmedAt} />
      </section>

      {loan.dispute && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">
            Dispute ({loan.dispute.state}) opened {when.format(loan.dispute.at)}
          </p>
          <p>{loan.dispute.reason}</p>
          {loan.dispute.resolution && (
            <p className="mt-1">
              Resolution: {loan.dispute.resolution} · {loan.dispute.note}
            </p>
          )}
          {loan.dispute.state === "open" && (
            <Link href="/admin/disputes" className="underline">
              Resolve in the dispute queue
            </Link>
          )}
        </section>
      )}

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-muted-foreground mb-1 text-sm font-medium">Photos</h2>
          <ul className="grid grid-cols-2 gap-2">
            {photos.map((p) => (
              <li key={p.id} className="overflow-hidden rounded border text-xs">
                {p.url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                  <img src={p.url} alt="" className="aspect-[4/3] w-full object-cover" />
                ) : (
                  <div className="bg-muted aspect-[4/3]" />
                )}
                <p className="p-1.5">
                  {p.phase} · {p.takenBy === loan.lender.id ? "lender" : "borrower"}{" "}
                  {p.condition && `· ${p.condition}`} · {when.format(p.at)}
                </p>
              </li>
            ))}
          </ul>
          {photos.length === 0 && <p className="text-muted-foreground text-sm">No photos.</p>}
        </div>
        <div>
          <h2 className="text-muted-foreground mb-1 text-sm font-medium">Timeline</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {loan.timeline.map((e) => (
              <li key={e.id} className="px-3 py-1.5">
                <span className="font-medium">{e.type}</span> · {when.format(e.at)}
                <pre className="text-muted-foreground mt-0.5 text-xs whitespace-pre-wrap">
                  {JSON.stringify(e.payload)}
                </pre>
              </li>
            ))}
          </ul>
          <h2 className="text-muted-foreground mt-4 mb-1 text-sm font-medium">Chat</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {loan.messages.map((m) => (
              <li key={m.id} className="px-3 py-1.5">
                <span className="font-medium">
                  {m.senderId === loan.lender.id
                    ? loan.lender.displayName
                    : loan.borrower.displayName}
                  :
                </span>{" "}
                {m.body}
                <span className="text-muted-foreground ml-2 text-xs">{when.format(m.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="rounded-lg border p-3">
        <h2 className="mb-2 font-medium">Override state</h2>
        <p className="text-muted-foreground mb-2 text-xs">
          Bypasses the state machine. Copy availability is set to match. Ledger and trust effects
          are not applied; adjust those on the member pages if needed.
        </p>
        <ActionForm action={overrideLoanAction} submitLabel="Override" variant="destructive">
          <input type="hidden" name="loanId" value={loan.id} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">New state</span>
            <select
              name="toState"
              defaultValue={loan.state}
              className="bg-background h-9 rounded-md border px-3"
            >
              {LOAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <ReasonField />
        </ActionForm>
      </section>
    </div>
  );
}

function Conf({ label, at }: { label: string; at: Date | null }) {
  return (
    <div className="rounded border p-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p>{at ? when.format(at) : "—"}</p>
    </div>
  );
}
