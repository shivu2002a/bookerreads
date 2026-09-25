"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { requestCopy } from "../actions";

type Method = "meetup" | "courier";

const OPTIONS: Array<{ value: Method; title: string; body: string }> = [
  {
    value: "meetup",
    title: "Meet up",
    body: "Agree a time and public spot in chat. Both of you confirm with a photo.",
  },
  {
    value: "courier",
    title: "Porter delivery",
    body: "You book and pay a Porter rider; share the pickup details in chat. Both of you confirm with a photo.",
  },
];

export function RequestForm({ copyId, methods }: { copyId: string; methods: Method[] }) {
  const router = useRouter();
  const [method, setMethod] = useState<Method>(methods[0]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    start(async () => {
      const res = await requestCopy({ copyId, handoffMethod: method });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast.success("Request sent. We'll let you know when the lender replies.");
      router.replace(`/loans/${res.data.loanId}`);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">How would you like to get it?</legend>
        <RadioGroup value={method} onValueChange={(v) => setMethod(v as Method)} className="gap-2">
          {OPTIONS.filter((o) => methods.includes(o.value)).map((o) => (
            <label
              key={o.value}
              className="has-[[data-checked]]:border-foreground flex items-start gap-3 rounded-lg border p-3"
            >
              <RadioGroupItem value={o.value} className="mt-0.5" />
              <span>
                <span className="block font-medium">{o.title}</span>
                <span className="text-muted-foreground block text-xs">{o.body}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      <Button size="lg" onClick={submit} disabled={pending}>
        {pending ? "Sending…" : "Send request"}
      </Button>
      <p className="text-muted-foreground text-xs">
        The lender has 48 hours to reply. If they accept, you&apos;ll have 24 hours to pay the
        rental price. You can have one request open until your first return.
      </p>
    </div>
  );
}
