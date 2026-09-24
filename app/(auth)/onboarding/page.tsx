import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentMember } from "@/lib/auth/current-member";
import { listClustersForOnboarding } from "@/lib/members/onboarding";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your profile" };

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent("/onboarding")}`);
  if (member.displayName && member.clusterId) redirect(next ?? "/shelf");

  const clusters = await listClustersForOnboarding(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Almost there</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Pick a name other members will see and the area you live in. We don&apos;t ask for your
          address.
        </p>
      </div>
      <OnboardingForm
        clusters={clusters}
        defaultDisplayName={member.displayName ?? ""}
        next={next}
      />
    </div>
  );
}
