"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmHandoffWithCode, confirmReturnWithCode } from "@/app/(member)/loans/actions";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isNetworkError, outbox } from "@/lib/offline/outbox";

type Condition = "like_new" | "good" | "worn";

export function DropPointCodeEntry({
  loanId,
  action,
  phase,
  isLender,
}: {
  loanId: string;
  action: "drop" | "collect";
  phase: "out" | "return";
  isLender: boolean;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [condition, setCondition] = useState<Condition | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const needsCondition = phase === "return" && isLender;

  function submit() {
    const c = code.trim().toUpperCase();
    setError(null);
    start(async () => {
      try {
        const res =
          phase === "out"
            ? await confirmHandoffWithCode(loanId, c)
            : await confirmReturnWithCode(loanId, c, condition ?? undefined);
        if (!res.ok) return setError(res.message);
        setDone(true);
        toast.success(action === "drop" ? "Drop-off recorded" : "Collection recorded");
        router.refresh();
      } catch (err) {
        if (isNetworkError(err) && outbox.supported()) {
          await outbox.add({
            loanId,
            action: phase === "out" ? "confirm_handoff_code" : "confirm_return_code",
            args: { code: c, condition: condition ?? undefined },
          });
          setDone(true);
          toast.info("You're offline. Saved; it will sync.");
        } else setError("Something went wrong. Please try again.");
      }
    });
  }

  if (done) return <p className="text-sm font-medium">Done. Thanks!</p>;

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        maxLength={6}
        placeholder="6-character code"
        className="text-center font-mono text-lg tracking-[0.3em]"
        aria-label="Handoff code"
        autoCapitalize="characters"
      />
      {needsCondition && (
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["like_new", "Like new"],
              ["good", "Good"],
              ["worn", "Worn"],
            ] as Array<[Condition, string]>
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setCondition(v)}
              className={`rounded-lg border p-2 text-sm ${condition === v ? "border-foreground bg-muted" : ""}`}
              aria-pressed={condition === v}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button
        onClick={submit}
        disabled={pending || code.trim().length !== 6 || (needsCondition && !condition)}
      >
        {pending ? "Confirming…" : action === "drop" ? "I've dropped it off" : "I've collected it"}
      </Button>
    </div>
  );
}
