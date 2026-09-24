"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatIndianMobile } from "@/lib/auth/phone";
import { sendOtp, verifyOtp, type SendOtpResult, type VerifyOtpResult } from "./actions";

const RESEND_SECONDS = 30;

export function LoginForm({ next }: { next?: string }) {
  const [sendState, sendAction, sending] = useActionState<SendOtpResult | null, FormData>(
    sendOtp,
    null,
  );
  const [verifyState, verifyAction, verifying] = useActionState<VerifyOtpResult | null, FormData>(
    verifyOtp,
    null,
  );
  const [editing, setEditing] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  const phone = sendState?.ok ? sendState.data.phone : null;
  const codeStep = Boolean(phone) && !editing;

  // A fresh successful send (including after "Change") returns to the code step.
  useEffect(() => {
    if (sendState?.ok) setEditing(false);
  }, [sendState]);

  useEffect(() => {
    if (!codeStep) return;
    setResendIn(RESEND_SECONDS);
    const id = setInterval(() => setResendIn((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [codeStep, sendState]);

  if (!codeStep) {
    return (
      <form action={sendAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="phone">Mobile number</Label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">+91</span>
            <Input
              id="phone"
              name="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="98450 12345"
              required
              autoFocus
              defaultValue={phone ? phone.slice(2) : ""}
              aria-invalid={sendState && !sendState.ok ? true : undefined}
            />
          </div>
          {sendState && !sendState.ok && (
            <p role="alert" className="text-destructive text-sm">
              {sendState.message}
            </p>
          )}
        </div>
        <Button type="submit" size="lg" disabled={sending}>
          {sending ? "Sending code…" : "Send code"}
        </Button>
      </form>
    );
  }

  return (
    <form action={verifyAction} className="flex flex-col gap-4">
      <input type="hidden" name="phone" value={phone!} />
      {next && <input type="hidden" name="next" value={next} />}
      <p className="text-sm">
        Code sent to <span className="font-medium">{formatIndianMobile(phone!)}</span>.{" "}
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() => setEditing(true)}
        >
          Change
        </button>
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="code">6-digit code</Label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          className="text-center text-2xl tracking-[0.5em]"
          aria-invalid={verifyState && !verifyState.ok ? true : undefined}
        />
        {verifyState && !verifyState.ok && (
          <p role="alert" className="text-destructive text-sm">
            {verifyState.message}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" disabled={verifying}>
        {verifying ? "Checking…" : "Continue"}
      </Button>
      <Button
        type="submit"
        variant="ghost"
        formAction={sendAction}
        disabled={sending || resendIn > 0}
      >
        {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
      </Button>
    </form>
  );
}
