"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import type { AnyActionResult } from "@/lib/actions/result";

/**
 * Plain HTML form posting to a server action that returns ActionResult.
 * Shows field errors inline, toasts the outcome, and refreshes the route.
 * Every admin form includes a `reason` input; the server enforces it.
 */
export function ActionForm({
  action,
  children,
  submitLabel = "Save",
  variant = "default",
  className,
  onSuccess,
}: {
  action: (formData: FormData) => Promise<AnyActionResult>;
  children: React.ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive";
  className?: string;
  onSuccess?: (data: unknown) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      className={className ?? "flex flex-col gap-3"}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const form = e.currentTarget;
        setMessage(null);
        setFields({});
        start(async () => {
          const res = await action(fd);
          if (!res.ok) {
            setFields(res.fields ?? {});
            setMessage(res.message);
            toast.error(res.message);
            return;
          }
          toast.success("Done");
          form.reset();
          onSuccess?.("data" in res ? res.data : undefined);
          router.refresh();
        });
      }}
    >
      {children}
      {Object.entries(fields).map(([k, v]) => (
        <p key={k} className="text-destructive text-xs">
          {k}: {v}
        </p>
      ))}
      {message && !Object.keys(fields).length && (
        <p role="alert" className="text-destructive text-sm">
          {message}
        </p>
      )}
      <Button type="submit" variant={variant} disabled={pending} className="self-start">
        {pending ? "Working…" : submitLabel}
      </Button>
    </form>
  );
}

export function ReasonField({ label = "Reason (logged)" }: { label?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        name="reason"
        required
        minLength={3}
        className="bg-background h-9 rounded-md border px-3"
      />
    </label>
  );
}

export function Field({
  name,
  label,
  type = "text",
  defaultValue,
  required,
  step,
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  step?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? ""}
        required={required}
        step={step}
        className="bg-background h-9 rounded-md border px-3"
      />
    </label>
  );
}
