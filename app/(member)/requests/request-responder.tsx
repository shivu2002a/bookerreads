"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { acceptRequest, declineRequest } from "../loans/actions";

type Decision = "pending" | "accepted" | "declined";
type Reason = "not_available" | "no_longer_have" | "other";

const REASONS: Array<[Reason, string]> = [
  ["not_available", "Not available right now"],
  ["no_longer_have", "I no longer have this book (unlists it)"],
  ["other", "Other"],
];

/**
 * Accept (with the in-hand confirmation, Requirement 5.4) or decline with a
 * reason. Optimistic: the card collapses immediately and reverts with a toast
 * if the server refuses (Requirement 14.3).
 */
export function RequestResponder({ loanId }: { loanId: string }) {
  const [pending, start] = useTransition();
  const [decision, setDecision] = useOptimistic<Decision, Decision>("pending", (_c, n) => n);
  const [mode, setMode] = useState<"idle" | "accept" | "decline">("idle");
  const [inHand, setInHand] = useState(false);
  const [reason, setReason] = useState<Reason>("not_available");

  function accept() {
    start(async () => {
      setDecision("accepted");
      const res = await acceptRequest(loanId, inHand);
      if (!res.ok) toast.error(res.message);
      else toast.success("Accepted. Chat is open with the borrower.");
    });
  }

  function decline() {
    start(async () => {
      setDecision("declined");
      const res = await declineRequest(loanId, reason);
      if (!res.ok) toast.error(res.message);
    });
  }

  if (decision === "accepted") {
    return (
      <p className="text-sm">
        Accepted.{" "}
        <Link href={`/loans/${loanId}`} className="underline">
          Arrange the handoff
        </Link>
      </p>
    );
  }
  if (decision === "declined") return <p className="text-muted-foreground text-sm">Declined.</p>;

  if (mode === "accept") {
    return (
      <div className="bg-muted/50 flex flex-col gap-3 rounded-md p-3">
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            checked={inHand}
            onCheckedChange={(v) => setInHand(Boolean(v))}
            className="mt-0.5"
          />
          <span>I have this book in my hands right now and can hand it over within 5 days.</span>
        </label>
        <div className="flex gap-2">
          <Button onClick={accept} disabled={!inHand || pending}>
            Confirm accept
          </Button>
          <Button variant="ghost" onClick={() => setMode("idle")}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "decline") {
    return (
      <div className="bg-muted/50 flex flex-col gap-3 rounded-md p-3">
        <div className="flex flex-col gap-2 text-sm">
          {REASONS.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name={`reason-${loanId}`}
                value={value}
                checked={reason === value}
                onChange={() => setReason(value)}
              />
              {label}
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="destructive" onClick={decline} disabled={pending}>
            Decline
          </Button>
          <Button variant="ghost" onClick={() => setMode("idle")}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Button className="flex-1" onClick={() => setMode("accept")}>
        Accept
      </Button>
      <Button variant="outline" className="flex-1" onClick={() => setMode("decline")}>
        Decline
      </Button>
    </div>
  );
}
