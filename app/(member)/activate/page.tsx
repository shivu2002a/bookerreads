import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { evaluateActivation } from "@/lib/members/activation";
import { ActivationPanel } from "./activation-panel";

export const metadata: Metadata = { title: "Activate borrowing" };

function safeReturn(v: string | undefined): string {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/search";
}

export default async function ActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ return?: string }>;
}) {
  const { return: ret } = await searchParams;
  const member = await requireOnboardedMember();
  const db = getDb();
  const config = await loadConfig(db);
  const status = await evaluateActivation(db, member.id, config);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Start borrowing</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          There is no subscription. You pay each lender&apos;s price per book. To borrow, put one
          book of your own on the shelf and leave a refundable deposit.
        </p>
      </div>
      <ActivationPanel
        initialStatus={status}
        depositPaise={config.deposit_paise}
        returnTo={safeReturn(ret)}
      />
    </div>
  );
}
