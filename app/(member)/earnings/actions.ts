"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { events, members } from "@/db/schema";
import { err, ok, type ActionResult } from "@/lib/actions/result";
import { requireOnboardedMember } from "@/lib/auth/current-member";

/** UPI VPA: handle@bank, e.g. name@okaxis. Letters, digits, . - _ before the @. */
const upiSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{2,64}@[a-z]{2,32}$/, "Enter a valid UPI ID like name@okaxis.");

/**
 * Saves the UPI id. Verification (marking upi_verified) is an admin action in
 * the MVP; a ₹1 RazorpayX validation is deferred (tasks.md 17.4).
 */
export async function saveUpiId(raw: string): Promise<ActionResult> {
  const member = await requireOnboardedMember();
  const parsed = upiSchema.safeParse(raw);
  if (!parsed.success) return err("invalid_upi", parsed.error.issues[0].message);
  if (parsed.data === member.upiId) return ok();
  const db = getDb();
  await db
    .update(members)
    .set({ upiId: parsed.data, upiVerified: false })
    .where(eq(members.id, member.id));
  await db.insert(events).values({
    aggregate: "member",
    aggregateId: member.id,
    type: "member.upi_updated",
    actorId: member.id,
    payload: {},
  });
  revalidatePath("/earnings");
  return ok();
}
