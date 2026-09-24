"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPaise } from "@/lib/money";
import {
  cancelMembership,
  deleteMyAccount,
  requestDepositRefund,
  updateDisplayName,
} from "./actions";

type Refund = { eligible: true; amountPaise: number } | { eligible: false; reason: string };

const REFUND_HINT: Record<string, string> = {
  not_cancelled: "Available once your plan is cancelled and the paid period has ended.",
  open_loans: "Available once all your loans are returned.",
  open_dispute: "Available once the open dispute is resolved.",
  nothing_to_refund: "No deposit is held.",
};

export function ProfileActions({
  displayName,
  hasPlan,
  refund,
  depositPaise,
  payoutPaise,
  payoutThresholdPaise,
}: {
  displayName: string;
  hasPlan: boolean;
  refund: Refund;
  depositPaise: number;
  payoutPaise: number;
  payoutThresholdPaise: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(displayName);
  const [confirm, setConfirm] = useState("");
  const [showDelete, setShowDelete] = useState(false);

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, success: string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.message ?? "Something went wrong.");
      else {
        toast.success(success);
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-sm font-medium">Display name</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => updateDisplayName(name), "Name updated");
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            aria-label="Display name"
          />
          <Button type="submit" variant="outline" disabled={pending || name.trim() === displayName}>
            Save
          </Button>
        </form>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Membership and deposit</h2>
        {hasPlan ? (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>
              Cancel your plan at the end of the current paid month. You can keep lending.
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => run(cancelMembership, "Your plan will end after the current period")}
            >
              Cancel plan
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No active plan.</p>
        )}
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>
            Deposit refund{depositPaise > 0 ? ` of ${formatPaise(depositPaise)}` : ""}.{" "}
            {!refund.eligible && (
              <span className="text-muted-foreground">{REFUND_HINT[refund.reason]}</span>
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !refund.eligible}
            onClick={() =>
              run(requestDepositRefund, "Refund started. It reaches your account within 7 days.")
            }
          >
            Refund deposit
          </Button>
        </div>
      </section>

      <section className="border-destructive/40 flex flex-col gap-3 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Delete account</h2>
        <p className="text-muted-foreground text-sm">
          Your books are unlisted and your profile removed. Loan history is kept for other
          members&apos; records.
          {payoutPaise > 0 && payoutPaise < payoutThresholdPaise && (
            <>
              {" "}
              Your payout balance of {formatPaise(payoutPaise)} is below the{" "}
              {formatPaise(payoutThresholdPaise)} payout minimum and will be forfeited, as noted at
              signup.
            </>
          )}
        </p>
        {!showDelete ? (
          <Button variant="destructive" size="sm" onClick={() => setShowDelete(true)}>
            Delete my account
          </Button>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => deleteMyAccount(confirm), "Account deleted");
            }}
          >
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Type DELETE"
              aria-label="Type DELETE to confirm"
            />
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || confirm.trim().toUpperCase() !== "DELETE"}
            >
              Confirm
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
