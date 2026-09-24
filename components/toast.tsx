"use client";

import { useEffect, useState } from "react";

/**
 * Minimal toast (about 1 KB) in place of a toast library, to protect the
 * 150 KB member-route budget. Module-level store; any client component can
 * call toast.success/error, and the single <Toaster /> in the root layout renders.
 */

type Toast = { id: number; kind: "success" | "error" | "info"; message: string };
type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const DURATION_MS = 4000;

function emit() {
  for (const l of listeners) l(toasts);
}

function push(kind: Toast["kind"], message: string) {
  const id = nextId++;
  toasts = [...toasts.slice(-2), { id, kind, message }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, DURATION_MS);
}

export const toast = {
  success: (message: string) => push("success", message),
  error: (message: string) => push("error", message),
  info: (message: string) => push("info", message),
};

const STYLES: Record<Toast["kind"], string> = {
  success: "bg-foreground text-background",
  error: "bg-destructive text-white",
  info: "bg-muted text-foreground border",
};

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    listeners.add(setItems);
    setItems(toasts);
    return () => {
      listeners.delete(setItems);
    };
  }, []);
  if (!items.length) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto max-w-sm rounded-lg px-4 py-2.5 text-sm shadow-lg ${STYLES[t.kind]}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
