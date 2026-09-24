"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveUpiId } from "./actions";

export function UpiForm({ current, verified }: { current: string | null; verified: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await saveUpiId(value);
          if (!res.ok) return setError(res.message);
          toast.success("UPI ID saved. We'll verify it before the first payout.");
          router.refresh();
        });
      }}
    >
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="name@okaxis"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="UPI ID"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={pending || value.trim().toLowerCase() === (current ?? "")}
        >
          Save
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {current
          ? verified
            ? "Verified. Payouts go here."
            : "Saved, pending verification. Payouts start once verified."
          : "Add a UPI ID to receive payouts."}
      </p>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </form>
  );
}
