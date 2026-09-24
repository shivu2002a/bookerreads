"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { events, ledgerEntries, members } from "@/db/schema";
import { err, ok, type ActionResult } from "@/lib/actions/result";
import { requireMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { cancelMember, checkRefundEligibility, deleteAccount } from "@/lib/members/membership";
import { getRazorpay } from "@/lib/payments/razorpay";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Requirement 4.6: leaving blocks new requests immediately (there is no paid
 * period to run down). Existing loans continue; the deposit is refunded once
 * nothing is open.
 */
export async function cancelMembership(): Promise<ActionResult> {
  const member = await requireMember();
  if (member.state !== "active")
    return err("not_active", "Your membership isn't active, so there's nothing to cancel.");
  await getDb().transaction((tx) => cancelMember(tx, member.id));
  revalidatePath("/profile");
  return ok();
}

/** Refund the held deposit to the original payment once nothing is outstanding. */
export async function requestDepositRefund(): Promise<ActionResult<{ amountPaise: number }>> {
  const member = await requireMember();
  const db = getDb();
  const eligibility = await checkRefundEligibility(db, member.id);
  if (!eligibility.ok) {
    const messages = {
      not_cancelled: "Cancel your membership first; then the deposit can be refunded.",
      open_loans: "You have loans still open. The deposit is refunded once they're all returned.",
      open_dispute: "A dispute on one of your loans is still being reviewed.",
      nothing_to_refund: "There's no deposit to refund.",
    };
    return err(eligibility.reason, messages[eligibility.reason]);
  }
  // Refund against the most recent deposit payment; Razorpay allows partial refunds across payments if needed.
  const [source] = await db
    .select({ ref: ledgerEntries.razorpayRef, amount: ledgerEntries.amountPaise })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.memberId, member.id),
        eq(ledgerEntries.account, "deposit"),
        eq(ledgerEntries.kind, "deposit_in"),
      ),
    )
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(1);
  if (!source?.ref)
    return err(
      "no_source",
      "We couldn't find the original payment. Contact support and we'll refund manually.",
    );
  try {
    await getRazorpay().createRefund({
      paymentId: source.ref,
      amountPaise: Math.min(eligibility.amountPaise, source.amount),
      memberId: member.id,
      purpose: "deposit_refund",
    });
  } catch (e) {
    console.error("createRefund failed", e);
    return err(
      "payment_provider",
      "Couldn't start the refund. Please try again, or contact support.",
    );
  }
  await db.insert(events).values({
    aggregate: "member",
    aggregateId: member.id,
    type: "member.refund_requested",
    actorId: member.id,
    payload: { amountPaise: eligibility.amountPaise },
  });
  revalidatePath("/profile");
  return ok({ amountPaise: eligibility.amountPaise });
}

/** Requirement 10.7: soft delete with below-threshold payout forfeiture (disclosed at signup). */
export async function deleteMyAccount(confirmation: string): Promise<ActionResult> {
  const member = await requireMember();
  if (confirmation.trim().toUpperCase() !== "DELETE")
    return err("confirm", "Type DELETE to confirm.");
  const db = getDb();
  const config = await loadConfig(db);
  const res = await db.transaction((tx) => deleteAccount(tx, member.id, config));
  if (!res.ok) {
    return err(
      res.reason,
      res.reason === "open_loans"
        ? "Finish or return your open loans first."
        : "Request your deposit refund first, then delete.",
    );
  }
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/?deleted=1");
}

export async function updateDisplayName(name: string): Promise<ActionResult> {
  const member = await requireMember();
  const { displayNameSchema } = await import("@/lib/members/onboarding");
  const parsed = displayNameSchema.safeParse(name);
  if (!parsed.success) return err("invalid", parsed.error.issues[0].message);
  await getDb().update(members).set({ displayName: parsed.data }).where(eq(members.id, member.id));
  revalidatePath("/profile");
  return ok();
}
