"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  confirmHandoffWithCode,
  confirmHandoffWithPhoto,
  confirmReturnWithCode,
  confirmReturnWithPhoto,
  extendLoan,
  openDispute,
} from "@/app/(member)/loans/actions";
import { PhotoCapture } from "@/components/photo-capture";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { NextStep } from "@/lib/loans/next-step";
import type { Party } from "@/lib/loans/types";
import { isNetworkError, outbox, subscribeOutbox } from "@/lib/offline/outbox";
import { installOutboxReplay } from "@/lib/offline/replay";

type Condition = "like_new" | "good" | "worn";

export type LoanActionsProps = {
  loanId: string;
  party: Party;
  step: NextStep;
  handoffCode: string | null;
  dropPoint: { id: string; name: string; address: string } | null;
  meetupSpots: string[];
  canExtend: boolean;
};

/**
 * State-specific actions for the loan page. Confirmations are optimistic:
 * on a network failure they go to the IndexedDB outbox and render as
 * "confirmed, will sync"; on a server refusal they revert with the message.
 */
export function LoanActions(props: LoanActionsProps) {
  const router = useRouter();
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    installOutboxReplay((r) => {
      if (r.sent) {
        toast.success("Your queued confirmation was sent.");
        router.refresh();
      }
      for (const f of r.failed) toast.error(f);
    });
    const check = () =>
      void outbox.pendingFor(props.loanId).then((items) => setQueued(items.length > 0));
    check();
    return subscribeOutbox(check);
  }, [props.loanId, router]);

  if (queued) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm">
        <p className="font-medium">Confirmed on this device</p>
        <p className="text-muted-foreground">It will sync as soon as you&apos;re back online.</p>
      </div>
    );
  }

  switch (props.step.action) {
    case "respond":
      return <Button render={<Link href="/requests" />}>Respond to this request</Button>;
    case "handoff_meetup":
      return <MeetupBlock {...props} phase="out" />;
    case "return_meetup":
      return <MeetupBlock {...props} phase="return" />;
    case "handoff_drop":
    case "handoff_collect":
      return <DropPointBlock {...props} phase="out" />;
    case "return_drop":
    case "return_collect":
      return <DropPointBlock {...props} phase="return" />;
    case "dispute_window":
      return <DisputeBlock loanId={props.loanId} />;
    case "wait_other":
    case "none":
      return props.canExtend ? <ExtendBlock loanId={props.loanId} /> : null;
  }
}

/**
 * Optimistic confirmation (Requirement 14.3): `confirmed` flips immediately and
 * the block renders its done state; a server refusal reverts it with the message.
 * Network failures go to the outbox and stay confirmed on this device.
 */
function useConfirm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  function run(
    call: () => Promise<
      { ok: true } | { ok: false; code: string; message: string } | { ok: true; data: unknown }
    >,
    queueItem: Parameters<typeof outbox.add>[0],
  ) {
    setError(null);
    setConfirmed(true);
    start(async () => {
      try {
        const res = await call();
        if (!res.ok) {
          setConfirmed(false);
          setError(res.message);
          return;
        }
        toast.success("Confirmed");
        router.refresh();
      } catch (err) {
        if (isNetworkError(err) && outbox.supported()) {
          await outbox.add(queueItem);
          toast.info("You're offline. Confirmation saved and will sync.");
        } else {
          setConfirmed(false);
          setError("Something went wrong. Please try again.");
        }
      }
    });
  }
  return { pending, error, confirmed, run };
}

function ConfirmedNotice() {
  return (
    <div className="rounded-lg border p-4 text-sm">
      <p className="font-medium">Confirmed</p>
      <p className="text-muted-foreground">Updating the loan…</p>
    </div>
  );
}

function ConditionPicker({
  value,
  onChange,
}: {
  value: Condition | null;
  onChange: (c: Condition) => void;
}) {
  return (
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
          onClick={() => onChange(v)}
          className={`rounded-lg border p-2 text-sm ${value === v ? "border-foreground bg-muted" : ""}`}
          aria-pressed={value === v}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function MeetupBlock({
  loanId,
  party,
  phase,
  meetupSpots,
  canExtend,
}: LoanActionsProps & { phase: "out" | "return" }) {
  const { pending, error, confirmed, run } = useConfirm();
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [condition, setCondition] = useState<Condition | null>(null);
  const lenderReceiving = phase === "return" && party === "lender";
  const ready = Boolean(photoPath) && (!lenderReceiving || condition !== null);

  function confirm() {
    if (!photoPath) return;
    if (phase === "out") {
      run(() => confirmHandoffWithPhoto(loanId, photoPath), {
        loanId,
        action: "confirm_handoff_photo",
        args: { photoPath },
      });
    } else {
      run(() => confirmReturnWithPhoto(loanId, photoPath, condition ?? undefined), {
        loanId,
        action: "confirm_return_photo",
        args: { photoPath, condition: condition ?? undefined },
      });
    }
  }

  if (confirmed && !error) return <ConfirmedNotice />;

  return (
    <div className="flex flex-col gap-4">
      {phase === "out" && meetupSpots.length > 0 && (
        <div className="bg-muted/50 rounded-lg p-3 text-sm">
          <p className="font-medium">Suggested public spots</p>
          <ul className="text-muted-foreground mt-1 list-disc pl-5">
            {meetupSpots.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      <PhotoCapture
        purpose={phase === "out" ? "handoff_out" : "handoff_return"}
        onUploaded={setPhotoPath}
        label={phase === "out" ? "Photo of the book at handover" : "Photo of the book as returned"}
      />
      {lenderReceiving && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Condition on return</p>
          <ConditionPicker value={condition} onChange={setCondition} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button size="lg" onClick={confirm} disabled={!ready || pending}>
        {pending
          ? "Confirming…"
          : phase === "out"
            ? "Handed over"
            : lenderReceiving
              ? "Received"
              : "Returned"}
      </Button>
      {phase === "return" && canExtend && <ExtendBlock loanId={loanId} />}
    </div>
  );
}

function DropPointBlock({
  loanId,
  party,
  phase,
  handoffCode,
  dropPoint,
  canExtend,
}: LoanActionsProps & { phase: "out" | "return" }) {
  const { pending, error, confirmed, run } = useConfirm();
  const [code, setCode] = useState("");
  const [condition, setCondition] = useState<Condition | null>(null);
  const lenderReceiving = phase === "return" && party === "lender";
  const ready = code.trim().length === 6 && (!lenderReceiving || condition !== null);

  function confirm() {
    const c = code.trim().toUpperCase();
    if (phase === "out")
      run(() => confirmHandoffWithCode(loanId, c), {
        loanId,
        action: "confirm_handoff_code",
        args: { code: c },
      });
    else
      run(() => confirmReturnWithCode(loanId, c, condition ?? undefined), {
        loanId,
        action: "confirm_return_code",
        args: { code: c, condition: condition ?? undefined },
      });
  }

  if (confirmed && !error) return <ConfirmedNotice />;

  return (
    <div className="flex flex-col gap-4">
      {dropPoint && (
        <div className="bg-muted/50 rounded-lg p-3 text-sm">
          <p className="font-medium">{dropPoint.name}</p>
          <p className="text-muted-foreground">{dropPoint.address}</p>
        </div>
      )}
      {handoffCode && (
        <div className="rounded-lg border p-3 text-center">
          <p className="text-muted-foreground text-xs">Your handoff code</p>
          <p className="font-mono text-2xl tracking-[0.3em]">{handoffCode}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Scan the poster QR at the venue, then enter this code there. Or enter it here once
            you&apos;re on site.
          </p>
        </div>
      )}
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        maxLength={6}
        placeholder="Handoff code"
        className="text-center font-mono text-lg tracking-[0.3em]"
        aria-label="Handoff code"
        autoCapitalize="characters"
      />
      {lenderReceiving && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Condition on return</p>
          <ConditionPicker value={condition} onChange={setCondition} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button size="lg" onClick={confirm} disabled={!ready || pending}>
        {pending
          ? "Confirming…"
          : party === "lender"
            ? phase === "out"
              ? "I've dropped it off"
              : "I've collected it"
            : phase === "out"
              ? "I've collected it"
              : "I've dropped it off"}
      </Button>
      {phase === "return" && canExtend && <ExtendBlock loanId={loanId} />}
    </div>
  );
}

function ExtendBlock({ loanId }: { loanId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <span>Need more time? One 7-day extension, no approval needed.</span>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await extendLoan(loanId);
            if (res.ok) {
              toast.success("Extended by 7 days");
              router.refresh();
            } else toast.error(res.message);
          })
        }
      >
        Extend
      </Button>
    </div>
  );
}

function DisputeBlock({ loanId }: { loanId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Report a problem with this return
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <p className="text-sm">
        Describe what&apos;s wrong. An admin will compare the handover and return photos and decide.
      </p>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="e.g. Spine cracked and several pages dog-eared; it went out like new."
      />
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="destructive"
          disabled={pending || reason.trim().length < 20}
          onClick={() =>
            start(async () => {
              const res = await openDispute(loanId, reason);
              if (res.ok) {
                toast.info("Reported. We'll review it and get back to you.");
                router.refresh();
              } else setError(res.message);
            })
          }
        >
          Submit report
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
