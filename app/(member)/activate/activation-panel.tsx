"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import type { ActivationStatus } from "@/lib/members/activation";
import { formatPaise } from "@/lib/money";
import { openCheckout } from "@/lib/payments/checkout-client";
import { confirmCheckout, createDepositOrder } from "./actions";

export function ActivationPanel({
  initialStatus,
  depositPaise,
  returnTo,
}: {
  initialStatus: ActivationStatus;
  depositPaise: number;
  returnTo: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();

  async function payDeposit() {
    setBusy(true);
    try {
      const handle = await createDepositOrder();
      if (!handle.ok) {
        toast.error(handle.message);
        return;
      }
      const result = await openCheckout(handle.data);
      const confirmed = await confirmCheckout(result);
      if (!confirmed.ok) {
        toast.error(confirmed.message);
        return;
      }
      setStatus(confirmed.data);
      toast.success("Deposit received");
      if (confirmed.data.ok) {
        toast.success("You're all set. Happy borrowing!");
        start(() => router.push(returnTo));
      } else router.refresh();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== "dismissed") toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  const c = status.checks;
  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col gap-3">
        <Check ok={c.borrowGate.ok} label={c.borrowGate.label} hint={c.borrowGate.hint} n={1}>
          {!c.borrowGate.ok && (
            <Button size="sm" variant="outline" render={<Link href="/shelf/add" />}>
              Add a book
            </Button>
          )}
        </Check>
        <Check
          ok={c.deposit.ok}
          label={c.deposit.label}
          hint={
            c.deposit.ok
              ? "Refunded within 7 days of leaving, if nothing is outstanding."
              : c.deposit.hint
          }
          n={2}
        >
          {!c.deposit.ok && (
            <Button onClick={payDeposit} disabled={busy}>
              {busy
                ? "Opening payment…"
                : `Pay ${formatPaise(depositPaise - status.counts.depositPaise)}`}
            </Button>
          )}
        </Check>
      </ol>
      {status.ok ? (
        <div className="rounded-lg border p-4">
          <p className="font-medium">You can borrow.</p>
          <Button className="mt-3" render={<Link href={returnTo} />}>
            Continue
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Your deposit covers a lost or damaged book up to its replacement value. You&apos;ll be
          asked to top it up if it drops below {formatPaise(depositPaise)}.
        </p>
      )}
    </div>
  );
}

function Check({
  ok,
  label,
  hint,
  n,
  children,
}: {
  ok: boolean;
  label: string;
  hint: string;
  n: number;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 rounded-lg border p-4">
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-medium ${ok ? "bg-foreground text-background" : "border"}`}
        aria-hidden
      >
        {ok ? "✓" : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <p className="font-medium">{label}</p>
          <p className="text-muted-foreground text-sm">{hint}</p>
        </div>
        {children}
      </div>
    </li>
  );
}
