"use client";

import { useOptimistic, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { relistCopyAction, unlistCopyAction } from "./actions";

type Availability = "available" | "requested" | "on_loan" | "unlisted" | "lost";

/**
 * Unlist / relist with optimistic state (Requirement 14.3): the button flips
 * immediately and reverts with a toast if the server refuses.
 */
export function ShelfCopyActions({
  copyId,
  availability,
}: {
  copyId: string;
  availability: Availability;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic<Availability, Availability>(
    availability,
    (_cur, next) => next,
  );

  if (availability === "requested" || availability === "on_loan" || availability === "lost")
    return null;

  const isListed = optimistic === "available";

  function toggle() {
    startTransition(async () => {
      setOptimistic(isListed ? "unlisted" : "available");
      const res = isListed ? await unlistCopyAction(copyId) : await relistCopyAction(copyId);
      if (!res.ok) toast.error(res.message);
    });
  }

  return (
    <div className="flex shrink-0 flex-col justify-center">
      <Button variant="outline" size="sm" onClick={toggle} disabled={pending}>
        {isListed ? "Unlist" : "Relist"}
      </Button>
    </div>
  );
}
