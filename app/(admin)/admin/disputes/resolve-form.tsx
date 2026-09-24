"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { formatPaise } from "@/lib/money";
import { resolveDisputeAction } from "../actions";

type Resolution = "dismissed" | "partial_charge" | "full_charge";

export function ResolveForm({
  disputeId,
  maxChargePaise,
}: {
  disputeId: string;
  maxChargePaise: number;
}) {
  const router = useRouter();
  const [resolution, setResolution] = useState<Resolution>("dismissed");
  const [charge, setCharge] = useState(Math.round(maxChargePaise / 2 / 100) * 100);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="bg-muted/40 flex flex-col gap-3 rounded-md p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await resolveDisputeAction({
            disputeId,
            resolution,
            chargePaise: resolution === "partial_charge" ? charge : undefined,
            note,
          });
          if (!res.ok) return setError(res.message);
          toast.success("Resolved; both parties notified");
          router.refresh();
        });
      }}
    >
      <div className="flex flex-wrap gap-4">
        {(
          [
            ["dismissed", "Dismiss (no charge)"],
            ["partial_charge", "Partial charge"],
            ["full_charge", `Full replacement (${formatPaise(maxChargePaise)})`],
          ] as Array<[Resolution, string]>
        ).map(([v, label]) => (
          <label key={v} className="flex items-center gap-2">
            <input
              type="radio"
              name={`res-${disputeId}`}
              checked={resolution === v}
              onChange={() => setResolution(v)}
            />
            {label}
          </label>
        ))}
      </div>
      {resolution === "partial_charge" && (
        <label className="flex items-center gap-2">
          Charge (paise, max {maxChargePaise})
          <input
            type="number"
            min={100}
            max={maxChargePaise}
            step={100}
            value={charge}
            onChange={(e) => setCharge(Number(e.target.value))}
            className="bg-background h-8 w-32 rounded border px-2"
          />
          <span className="text-muted-foreground">= {formatPaise(charge)}</span>
        </label>
      )}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        required
        minLength={5}
        placeholder="Decision note (sent to both parties and logged)"
        className="bg-background rounded border p-2"
      />
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        disabled={pending || note.trim().length < 5}
        className="self-start"
      >
        {pending ? "Resolving…" : "Resolve"}
      </Button>
    </form>
  );
}
