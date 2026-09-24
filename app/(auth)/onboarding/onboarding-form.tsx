"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { OnboardingClusters } from "@/lib/members/onboarding";
import { submitOnboarding, type OnboardingResult } from "./actions";

const OTHER = "__other__";

export function OnboardingForm({
  clusters,
  defaultDisplayName,
  next,
}: {
  clusters: OnboardingClusters;
  defaultDisplayName: string;
  next?: string;
}) {
  const [state, action, pending] = useActionState<OnboardingResult | null, FormData>(
    submitOnboarding,
    null,
  );
  const [choice, setChoice] = useState<string>(clusters.open[0]?.id ?? OTHER);
  const fields = state && !state.ok ? (state.fields ?? {}) : {};

  if (state?.ok) {
    return (
      <div className="flex flex-col gap-4 rounded-lg border p-4">
        <h2 className="font-medium">You&apos;re on the list for {state.data.waitlisted}</h2>
        <p className="text-muted-foreground text-sm">
          We&apos;ll message you when it opens. Meanwhile you can browse any open area and start
          listing your books so they&apos;re ready on day one.
        </p>
        <Button render={<Link href="/c/central-east" />}>Browse Central-East</Button>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      {next && <input type="hidden" name="next" value={next} />}
      <input type="hidden" name="mode" value={choice === OTHER ? "pincode" : "cluster"} />
      {choice !== OTHER && <input type="hidden" name="clusterId" value={choice} />}

      <div className="flex flex-col gap-2">
        <Label htmlFor="displayName">Display name</Label>
        <Input
          id="displayName"
          name="displayName"
          defaultValue={defaultDisplayName}
          maxLength={30}
          autoComplete="nickname"
          required
          aria-invalid={fields.displayName ? true : undefined}
        />
        {fields.displayName && (
          <p role="alert" className="text-destructive text-sm">
            {fields.displayName}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Your area</legend>
        <RadioGroup value={choice} onValueChange={(v) => setChoice(String(v))} className="gap-2">
          {clusters.open.map((c) => (
            <label
              key={c.id}
              className="has-[[data-checked]]:border-foreground flex items-center gap-3 rounded-lg border p-3"
            >
              <RadioGroupItem value={c.id} id={`c-${c.id}`} />
              <span className="flex-1">
                <span className="block font-medium">{c.name}</span>
                <span className="text-muted-foreground block text-xs">Open now</span>
              </span>
            </label>
          ))}
          <label className="has-[[data-checked]]:border-foreground flex items-center gap-3 rounded-lg border p-3">
            <RadioGroupItem value={OTHER} id="c-other" />
            <span className="flex-1">
              <span className="block font-medium">Somewhere else in Bangalore</span>
              <span className="text-muted-foreground block text-xs">
                {clusters.waitlist.length
                  ? `Coming soon: ${clusters.waitlist.map((c) => c.name).join(", ")}`
                  : "Join the waitlist for your area"}
              </span>
            </span>
          </label>
        </RadioGroup>
        {choice === OTHER && (
          <div className="flex flex-col gap-2 pl-1">
            <Label htmlFor="pincode">Your pincode</Label>
            <Input
              id="pincode"
              name="pincode"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="560041"
              required
              aria-invalid={fields.pincode ? true : undefined}
            />
            {fields.pincode && (
              <p role="alert" className="text-destructive text-sm">
                {fields.pincode}
              </p>
            )}
          </div>
        )}
        {fields.clusterId && (
          <p role="alert" className="text-destructive text-sm">
            {fields.clusterId}
          </p>
        )}
      </fieldset>

      <label className="flex items-start gap-3 text-sm">
        <Checkbox name="terms" className="mt-0.5" />
        <span>
          I agree to the{" "}
          <Link href="/terms" className="underline underline-offset-2" target="_blank">
            terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline underline-offset-2" target="_blank">
            privacy notice
          </Link>
          , including that a payout balance under ₹200 is forfeited if I delete my account.
        </span>
      </label>
      {fields.terms && (
        <p role="alert" className="text-destructive text-sm">
          {fields.terms}
        </p>
      )}

      {state && !state.ok && !Object.keys(fields).length && (
        <p role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
      )}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Saving…" : choice === OTHER ? "Join waitlist" : "Start listing books"}
      </Button>
    </form>
  );
}
