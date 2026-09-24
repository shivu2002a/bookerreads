import "server-only";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "@/db/client";
import { members } from "@/db/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type CurrentMember = typeof members.$inferSelect;

export class NotSignedInError extends Error {
  readonly code = "not_signed_in";
  constructor() {
    super("You need to sign in to do that.");
  }
}

export class NotOnboardedError extends Error {
  readonly code = "not_onboarded";
  constructor() {
    super("Finish setting up your profile first.");
  }
}

export class NotAdminError extends Error {
  readonly code = "not_admin";
  constructor() {
    super("Not found.");
  }
}

/**
 * The signed-in auth user, validated against Supabase Auth (not just the cookie).
 * Memoised per request with React `cache`, so layouts, pages, and actions in
 * the same render share one round trip.
 */
export const getAuthUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
});

/**
 * The members row for the signed-in user, or null when signed out or when the
 * row has not been created yet (first login before onboarding).
 */
export const getCurrentMember = cache(async (): Promise<CurrentMember | null> => {
  const user = await getAuthUser();
  if (!user) return null;
  const rows = await getDb().select().from(members).where(eq(members.authUserId, user.id)).limit(1);
  const member = rows[0];
  if (!member || member.deletedAt) return null;
  return member;
});

/** Signed in with a members row. Throws NotSignedInError otherwise. */
export async function requireMember(): Promise<CurrentMember> {
  const member = await getCurrentMember();
  if (!member) throw new NotSignedInError();
  return member;
}

/** Signed in, members row exists, and onboarding (display name + cluster) is complete. */
export async function requireOnboardedMember(): Promise<
  CurrentMember & { displayName: string; clusterId: string }
> {
  const member = await requireMember();
  if (!member.displayName || !member.clusterId) throw new NotOnboardedError();
  return member as CurrentMember & { displayName: string; clusterId: string };
}

/** Members with is_admin. The flag is set only via SQL (Requirement 13.1). */
export async function requireAdmin(): Promise<CurrentMember> {
  const member = await requireMember();
  if (!member.isAdmin) throw new NotAdminError();
  return member;
}
