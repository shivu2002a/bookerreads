"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { fetchMessages, sendMessage, type ChatMessage } from "@/app/(member)/loans/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const POLL_MS = 5000;
const time = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });

/**
 * In-loan chat (Requirement 5.5, 15.1): the only contact channel between the
 * parties. Polls every 5 s while open; Supabase Realtime is deferred.
 */
export function LoanChat({
  loanId,
  meId,
  initial,
  open,
  otherName,
}: {
  loanId: string;
  meId: string;
  initial: ChatMessage[];
  open: boolean;
  otherName: string;
}) {
  const [messages, setMessages] = useState(initial);
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const latestAt = messages.length ? messages[messages.length - 1].at : null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await fetchMessages(loanId, latestAt).catch(() => null);
      if (cancelled || !res?.ok || !res.data.length) return;
      setMessages((cur) => {
        const seen = new Set(cur.map((m) => m.id));
        return [...cur, ...res.data.filter((m) => !seen.has(m.id))];
      });
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [loanId, latestAt, open]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    const optimistic: ChatMessage = {
      id: `tmp-${Date.now()}`,
      senderId: meId,
      body,
      at: new Date().toISOString(),
    };
    setMessages((cur) => [...cur, optimistic]);
    setDraft("");
    start(async () => {
      const res = await sendMessage(loanId, body);
      if (!res.ok) {
        setMessages((cur) => cur.filter((m) => m.id !== optimistic.id));
        setDraft(body);
        setError(res.message);
        return;
      }
      setMessages((cur) => cur.map((m) => (m.id === optimistic.id ? res.data : m)));
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-muted-foreground text-sm font-medium">Chat with {otherName}</h2>
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-lg border p-3">
        {messages.length === 0 && (
          <p className="text-muted-foreground text-center text-sm">
            No messages yet. Say hi and suggest a time.
          </p>
        )}
        {messages.map((m) => {
          const mine = m.senderId === meId;
          return (
            <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-sm ${mine ? "bg-foreground text-background" : "bg-muted"}`}
              >
                {m.body}
              </div>
              <span className="text-muted-foreground mt-0.5 text-[10px]">
                {time.format(new Date(m.at))}
              </span>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      {open ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
            placeholder="Message"
            aria-label="Message"
          />
          <Button type="submit" disabled={pending || !draft.trim()}>
            Send
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground text-xs">Chat is closed for this loan.</p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
