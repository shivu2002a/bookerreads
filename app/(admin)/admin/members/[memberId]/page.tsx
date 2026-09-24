import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getMemberDetail } from "@/lib/admin/members";
import { formatPaise } from "@/lib/money";
import { ActionForm, Field, ReasonField } from "../../_components/action-form";
import { when } from "../../_components/fmt";
import { memberAction } from "../../actions";

export default async function AdminMemberPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const { memberId } = await params;
  const d = await getMemberDetail(getDb(), memberId);
  if (!d) notFound();
  const m = d.member;
  const hidden = <input type="hidden" name="memberId" value={m.id} />;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">{m.displayName ?? "(no name)"}</h1>
        <p className="text-muted-foreground text-sm">
          {m.state} · {d.cluster ?? "no cluster"} · {d.plan ?? "no plan"} · trust {m.trustScore} ·
          joined {when.format(m.createdAt)}
          {m.suspendedUntil && <> · suspended until {when.format(m.suspendedUntil)}</>}
        </p>
        <p className="text-sm">
          Deposit {formatPaise(m.depositBalancePaise)}{" "}
          {m.needsTopup && <span className="text-amber-700">(needs top-up)</span>} · Payout{" "}
          {formatPaise(m.payoutBalancePaise)} · UPI {m.upiId ?? "—"}{" "}
          {m.upiId && (m.upiVerified ? "(verified)" : "(unverified)")}
        </p>
        <Link href={`/m/${m.id}`} className="text-xs underline">
          Public shelf
        </Link>
      </header>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border p-3">
          <h2 className="mb-2 font-medium">{m.state === "suspended" ? "Reinstate" : "Suspend"}</h2>
          <ActionForm
            action={memberAction}
            submitLabel={m.state === "suspended" ? "Reinstate" : "Suspend"}
            variant={m.state === "suspended" ? "default" : "destructive"}
          >
            {hidden}
            <input
              type="hidden"
              name="kind"
              value={m.state === "suspended" ? "reinstate" : "suspend"}
            />
            {m.state !== "suspended" && (
              <Field name="days" label="Days" type="number" defaultValue={30} />
            )}
            <ReasonField />
          </ActionForm>
        </div>
        <div className="rounded-lg border p-3">
          <h2 className="mb-2 font-medium">Adjust deposit</h2>
          <ActionForm action={memberAction} submitLabel="Post adjustment">
            {hidden}
            <input type="hidden" name="kind" value="adjust_deposit" />
            <Field
              name="amountPaise"
              label="Amount in paise (negative to charge)"
              type="number"
              required
            />
            <ReasonField />
          </ActionForm>
        </div>
        <div className="rounded-lg border p-3">
          <h2 className="mb-2 font-medium">UPI</h2>
          <ActionForm
            action={memberAction}
            submitLabel={m.upiVerified ? "Mark unverified" : "Mark verified"}
            variant="outline"
          >
            {hidden}
            <input
              type="hidden"
              name="kind"
              value={m.upiVerified ? "upi_unverify" : "upi_verify"}
            />
            <ReasonField label={`Reason (UPI: ${m.upiId ?? "none"})`} />
          </ActionForm>
        </div>
        <div className="rounded-lg border p-3">
          <h2 className="mb-2 font-medium">Add note</h2>
          <ActionForm action={memberAction} submitLabel="Add note" variant="outline">
            {hidden}
            <input type="hidden" name="kind" value="note" />
            <ReasonField label="Note" />
          </ActionForm>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <List
          title={`Loans (${d.loans.length})`}
          rows={d.loans.map((l) => (
            <>
              <Link href={`/admin/loans/${l.id}`} className="underline">
                {l.state}
              </Link>{" "}
              as {l.role} · {when.format(l.requestedAt)}
            </>
          ))}
        />
        <List
          title={`Copies (${d.copies.length})`}
          rows={d.copies.map((c) => (
            <>
              {c.availability} · {c.verificationStatus} · {when.format(c.createdAt)}
            </>
          ))}
        />
        <List
          title="Ledger"
          rows={d.ledger.map((e) => (
            <>
              {e.account}/{e.kind} {formatPaise(e.amountPaise)} {e.note && `· ${e.note}`} ·{" "}
              {when.format(e.createdAt)}
            </>
          ))}
        />
        <List
          title="Trust events"
          rows={d.trust.map((t) => (
            <>
              {t.kind} {t.delta > 0 ? "+" : ""}
              {t.delta} · {when.format(t.createdAt)}
            </>
          ))}
        />
        <List
          title="Admin actions and notes"
          rows={d.actions.map((a) => (
            <>
              <span className="font-medium">{a.action}</span> · {a.reason} ·{" "}
              {when.format(a.createdAt)}
            </>
          ))}
        />
        <List
          title="Recent notifications"
          rows={d.notifications.map((n) => (
            <>
              {n.template} · {n.channel} · {n.status} · {when.format(n.createdAt)}
            </>
          ))}
        />
      </section>
    </div>
  );
}

function List({ title, rows }: { title: string; rows: React.ReactNode[] }) {
  return (
    <div>
      <h2 className="text-muted-foreground mb-1 text-sm font-medium">{title}</h2>
      {rows.length ? (
        <ul className="divide-y rounded-lg border text-sm">
          {rows.map((r, i) => (
            <li key={i} className="px-3 py-1.5">
              {r}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">None.</p>
      )}
    </div>
  );
}
