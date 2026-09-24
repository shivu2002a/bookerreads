import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { plans } from "@/db/schema";
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
  const [status, planRows] = await Promise.all([
    evaluateActivation(db, member.id, config),
    db
      .select({
        code: plans.code,
        name: plans.name,
        pricePaise: plans.pricePaise,
        concurrentLimit: plans.concurrentLimit,
        loanPeriodDays: plans.loanPeriodDays,
      })
      .from(plans)
      .where(eq(plans.active, true))
      .orderBy(plans.pricePaise),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Start borrowing</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Listing is free. To borrow, pick a monthly plan, pay a refundable deposit, and have a few
          books on your own shelf.
        </p>
      </div>
      <ActivationPanel
        initialStatus={status}
        plans={planRows}
        currentPlanCode={planRows.find((p) => p.code === "regular")?.code ?? planRows[0]?.code}
        depositPaise={config.deposit_paise}
        returnTo={safeReturn(ret)}
        memberState={member.state}
      />
    </div>
  );
}
