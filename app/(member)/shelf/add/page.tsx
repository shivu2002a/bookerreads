import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { countListedCopies } from "@/lib/copies/manage";
import { remainingListingAllowance } from "@/lib/copies/rules";
import { AddCopyWizard } from "./add-copy-wizard";

export const metadata: Metadata = { title: "Add a book" };

export default async function AddCopyPage() {
  const member = await requireOnboardedMember();
  const db = getDb();
  const [config, listed] = await Promise.all([loadConfig(db), countListedCopies(db, member.id)]);
  const allowance = remainingListingAllowance({
    memberCreatedAt: member.createdAt,
    now: new Date(),
    currentCopyCount: listed,
    newAccountAgeDays: config.new_account_age_days,
    cap: config.new_account_listing_cap,
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Add a book</h1>
      {Number.isFinite(allowance) && (
        <p className="bg-muted rounded-md px-3 py-2 text-sm">
          New accounts can list {config.new_account_listing_cap} books in their first{" "}
          {config.new_account_age_days} days. You can add {allowance} more.
        </p>
      )}
      <AddCopyWizard remaining={Number.isFinite(allowance) ? allowance : null} />
    </div>
  );
}
