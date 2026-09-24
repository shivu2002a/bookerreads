"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import type { AnyActionResult } from "@/lib/actions/result";

/** One-click admin action, optionally prompting for a reason first. */
export function SimpleButton({
  label,
  action,
  promptReason,
  variant = "outline",
  size = "sm",
}: {
  label: string;
  action: (reason: string) => Promise<AnyActionResult>;
  promptReason?: string;
  variant?: "default" | "outline" | "destructive" | "ghost";
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant={variant}
      size={size}
      disabled={pending}
      onClick={() => {
        const reason = promptReason ? window.prompt(promptReason) : "manual";
        if (!reason) return;
        start(async () => {
          const res = await action(reason);
          if (res.ok) {
            toast.success("Done");
            router.refresh();
          } else toast.error(res.message);
        });
      }}
    >
      {pending ? "Working…" : label}
    </Button>
  );
}
