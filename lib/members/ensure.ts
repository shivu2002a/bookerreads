import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { events, members } from "@/db/schema";
import { hashPhone } from "@/lib/auth/phone-hash";

export type EnsureMemberInput = {
  authUserId: string;
  /** E.164 without plus, as Supabase Auth stores it. */
  phone: string;
};

export type EnsureMemberResult = {
  member: typeof members.$inferSelect;
  created: boolean;
};

/**
 * Creates the members row for a freshly verified auth user, or returns the
 * existing one (Requirement 1.2). Idempotent under concurrent first logins:
 * the unique index on auth_user_id makes the second insert a no-op and we
 * re-read. The raw phone is hashed here and never stored (Requirement 15.2).
 */
export async function ensureMemberForAuthUser(
  db: DbOrTx,
  input: EnsureMemberInput,
): Promise<EnsureMemberResult> {
  const existing = await db
    .select()
    .from(members)
    .where(eq(members.authUserId, input.authUserId))
    .limit(1);
  if (existing[0]) return { member: existing[0], created: false };

  const inserted = await db
    .insert(members)
    .values({
      authUserId: input.authUserId,
      phoneHash: hashPhone(input.phone),
      state: "registered",
      trustScore: 50,
    })
    .onConflictDoNothing({ target: members.authUserId })
    .returning();

  if (inserted[0]) {
    await db.insert(events).values({
      aggregate: "member",
      aggregateId: inserted[0].id,
      type: "member.created",
      actorId: inserted[0].id,
      payload: {},
    });
    return { member: inserted[0], created: true };
  }

  // Lost the race; the other request inserted it.
  const raced = await db
    .select()
    .from(members)
    .where(eq(members.authUserId, input.authUserId))
    .limit(1);
  return { member: raced[0], created: false };
}
