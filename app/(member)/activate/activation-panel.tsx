"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import type { ActivationStatus } from "@/lib/members/activation";
import { formatPaise } from "@/lib/money";
import { openCheckout } from "@/lib/payments/checkout-client";
import {
  confirmCheckout,
  createDepositOrder,
  startSubscription,
  type CheckoutHandle,
} from "./actions";

type Plan = {
  code: string;
  name: string;
  pricePaise: number;
  concurrentLimit: number;
  loanPeriodDays: number;
};

export function ActivationPanel({
  initialStatus,
  plans,
  currentPlanCode,
  depositPaise,
  returnTo,
  memberState,
}: {
  initialStatus: ActivationStatus;
  plans: Plan[];
  currentPlanCode?: string;
  depositPaise: number;
  returnTo: string;
  memberState: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [planCode, setPlanCode] = useState(currentPlanCode ?? plans[0]?.code);
  const [busy, setBusy] = useState<"plan" | "deposit" | null>(null);
  const [, start] = useTransition();

  async function pay(
    kind: "plan" | "deposit",
    getHandle: () => Promise<{ ok: true; data: CheckoutHandle } | { ok: false; message: string }>,
  ) {
    setBusy(kind);
    try {
      const handle = await getHandle();
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
      toast.success(kind === "plan" ? "Plan started" : "Deposit received");
      if (confirmed.data.ok) {
        toast.success("You're all set. Happy borrowing!");
        start(() => router.push(returnTo));
      } else router.refresh();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== "dismissed") toast.error(msg);
    } finally {
      setBusy(null);
    }
  }

  const c = status.checks;

  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col gap-3">
        <Check ok={c.borrowGate.ok} label={c.borrowGate.label} hint={c.borrowGate.hint} n={1}>
          {!c.borrowGate.ok && (
            <Button size="sm" variant="outline" render={<Link href="/shelf/add" />}>
              Add books
            </Button>
          )}
        </Check>

        <Check
          ok={c.subscription.ok}
          label={c.subscription.label}
          hint={
            memberState === "lapsed"
              ? c.subscription.hint
              : "Change or cancel any time. Lenders receive 30% of what you pay."
          }
          n={2}
        >
          {!c.subscription.ok && (
            <div className="flex flex-col gap-3">
              <div className="grid gap-2 sm:grid-cols-3">
                {plans.map((p) => (
                  <label
                    key={p.code}
                    className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm ${planCode === p.code ? "border-foreground bg-muted/40" : ""}`}
                  >
                    <input
                      type="radio"
                      name="plan"
                      className="sr-only"
                      checked={planCode === p.code}
                      onChange={() => setPlanCode(p.code)}
                    />
                    <span className="font-medium">{p.name}</span>
                    <span className="text-lg font-semibold">
                      {formatPaise(p.pricePaise)}
                      <span className="text-muted-foreground text-xs font-normal">/month</span>
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {p.concurrentLimit} book{p.concurrentLimit === 1 ? "" : "s"} at a time ·{" "}
                      {p.loanPeriodDays} days each
                    </span>
                  </label>
                ))}
              </div>
              <Button
                onClick={() => pay("plan", () => startSubscription(planCode))}
                disabled={busy !== null || !planCode}
              >
                {busy === "plan" ? "Opening payment…" : "Start plan"}
              </Button>
            </div>
          )}
        </Check>

        <Check
          ok={c.deposit.ok}
          label={c.deposit.label}
          hint={
            c.deposit.ok
              ? "Refunded within 7 days of cancelling, if nothing is outstanding."
              : c.deposit.hint
          }
          n={3}
        >
          {!c.deposit.ok && (
            <Button onClick={() => pay("deposit", createDepositOrder)} disabled={busy !== null}>
              {busy === "deposit"
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
