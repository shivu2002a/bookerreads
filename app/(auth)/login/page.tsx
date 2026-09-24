import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth/current-member";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const member = await getCurrentMember();
  if (member) {
    redirect(member.displayName && member.clusterId ? (next ?? "/shelf") : "/onboarding");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in with your phone</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          We&apos;ll text you a 6-digit code. No password, no email.
        </p>
      </div>
      <LoginForm next={next} />
      <p className="text-muted-foreground text-xs">
        Your number is used only to sign you in and is never shown to other members.
      </p>
    </div>
  );
}
