"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { mergeBooksAction } from "../../actions";

export function MergeForm({ duplicateId }: { duplicateId: string }) {
  const router = useRouter();
  const [survivorId, setSurvivorId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await mergeBooksAction(duplicateId, survivorId.trim(), reason);
          if (res.ok) {
            toast.success(`Merged; ${res.data.movedCopies} copies moved`);
            router.push(`/admin/catalogue/${survivorId.trim()}`);
          } else toast.error(res.message);
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Survivor book id</span>
        <input
          value={survivorId}
          onChange={(e) => setSurvivorId(e.target.value)}
          required
          className="bg-background h-9 w-80 rounded-md border px-3 font-mono text-xs"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Reason</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
          className="bg-background h-9 w-64 rounded-md border px-3"
        />
      </label>
      <Button type="submit" variant="destructive" disabled={pending}>
        Merge
      </Button>
    </form>
  );
}
