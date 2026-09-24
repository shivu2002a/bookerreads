"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { err, fieldErrors, type ActionResult } from "@/lib/actions/result";
import { track } from "@/lib/analytics/server";
import { requireMember } from "@/lib/auth/current-member";
import {
  completeOnboarding,
  displayNameSchema,
  joinWaitlist,
  pincodeSchema,
} from "@/lib/members/onboarding";

const schema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("cluster"),
    displayName: displayNameSchema,
    clusterId: z.uuid("Pick your area."),
    terms: z.literal("on", { error: "Please accept the terms to continue." }),
  }),
  z.object({
    mode: z.literal("pincode"),
    displayName: displayNameSchema,
    pincode: pincodeSchema,
    terms: z.literal("on", { error: "Please accept the terms to continue." }),
  }),
]);

function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
    ? next
    : "/shelf";
}

export type OnboardingResult = ActionResult<{ waitlisted: string }>;

export async function submitOnboarding(
  _prev: unknown,
  formData: FormData,
): Promise<OnboardingResult> {
  const member = await requireMember();
  const raw = Object.fromEntries(formData.entries());
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return err("invalid", "Check the highlighted fields.", fieldErrors(parsed.error.issues));
  }
  const db = getDb();
  const next = safeNext(formData.get("next"));

  if (parsed.data.mode === "cluster") {
    const res = await completeOnboarding(db, {
      memberId: member.id,
      displayName: parsed.data.displayName,
      clusterId: parsed.data.clusterId,
    });
    if (!res.ok) return err(res.error, "That area isn't open yet. Join its waitlist instead.");
    track(member.id, "member_onboarded", { clusterId: parsed.data.clusterId });
    redirect(next);
  }

  const res = await joinWaitlist(db, {
    memberId: member.id,
    displayName: parsed.data.displayName,
    pincode: parsed.data.pincode,
  });
  if (!res.ok) {
    return err(
      "no_cluster",
      "We're not in that pincode yet. Pick the nearest open area, or check back soon.",
      {
        pincode: "Not covered yet",
      },
    );
  }
  if (res.cluster.status === "open") {
    // Pincode maps to an open cluster; finish onboarding directly.
    await completeOnboarding(db, {
      memberId: member.id,
      displayName: parsed.data.displayName,
      clusterId: res.cluster.id,
    });
    track(member.id, "member_onboarded", { clusterId: res.cluster.id });
    redirect(next);
  }
  return { ok: true, data: { waitlisted: res.cluster.name } };
}
