"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const DISMISS_KEY = "br:install-dismissed-until";
const ELIGIBLE_KEY = "br:install-eligible";
const DISMISS_DAYS = 30;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/** Call after the member's first successful listing; the prompt shows from then on. */
export function markInstallEligible() {
  try {
    localStorage.setItem(ELIGIBLE_KEY, "1");
    window.dispatchEvent(new Event("br:install-eligible"));
  } catch {}
}

/**
 * Registers the service worker and, once the member has listed a book, offers
 * the install prompt. Dismissal is remembered for 30 days (task 24.1).
 */
export function Pwa() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((e) => console.warn("sw registration failed", e));
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  useEffect(() => {
    if (!installEvent) return;
    const check = () => {
      try {
        const eligible = localStorage.getItem(ELIGIBLE_KEY) === "1";
        const until = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
        setVisible(eligible && Date.now() > until);
      } catch {
        setVisible(false);
      }
    };
    check();
    window.addEventListener("storage", check);
    window.addEventListener("br:install-eligible", check);
    return () => {
      window.removeEventListener("storage", check);
      window.removeEventListener("br:install-eligible", check);
    };
  }, [installEvent]);

  if (!visible || !installEvent) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 86_400_000));
    } catch {}
    setVisible(false);
  };

  return (
    <div className="bg-background fixed inset-x-3 bottom-16 z-40 flex items-center gap-3 rounded-lg border p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">Add BookerReads to your home screen</p>
        <p className="text-muted-foreground text-xs">
          Opens instantly, works offline for handoffs.
        </p>
      </div>
      <Button
        size="sm"
        onClick={async () => {
          await installEvent.prompt();
          const { outcome } = await installEvent.userChoice;
          if (outcome === "accepted") setVisible(false);
          else dismiss();
        }}
      >
        Install
      </Button>
      <Button size="sm" variant="ghost" onClick={dismiss} aria-label="Not now">
        ✕
      </Button>
    </div>
  );
}
