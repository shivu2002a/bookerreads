"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { err, ok, type ActionResult } from "@/lib/actions/result";
import { track, type AnalyticsEvent } from "@/lib/analytics/server";
import { requireOnboardedMember, type CurrentMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { applyLoanEvent, createLoanRequest } from "@/lib/loans/persist";
import { isLoanParty, listMessagesSince, sendLoanMessage } from "@/lib/loans/queries";
import type { Actor, LoanEvent } from "@/lib/loans/types";
import { verifyUploadedPhoto } from "@/lib/photos/storage";
import { flushNotifications } from "@/lib/notify";

const uuid = z.uuid();
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/, "Codes are 6 letters and numbers.");
const condition = z.enum(["like_new", "good", "worn"]);

const actorOf = (m: CurrentMember): Actor => ({
  kind: "member",
  memberId: m.id,
  isAdmin: m.isAdmin,
});

function revalidateLoan(loanId: string) {
  revalidatePath("/requests");
  revalidatePath(`/loans/${loanId}`);
  revalidatePath("/shelf");
}

/** Shared tail for every event action: apply, revalidate, track, map result. */
async function apply(
  member: CurrentMember,
  loanId: string,
  event: LoanEvent,
  analytics?: AnalyticsEvent,
): Promise<ActionResult<{ state: string }>> {
  const db = getDb();
  const config = await loadConfig(db);
  const res = await applyLoanEvent(db, loanId, event, actorOf(member), config);
  if (!res.ok) return err(res.error.code, res.error.message);
  if (analytics) track(member.id, analytics, { loanId });
  revalidateLoan(loanId);
  await flushNotifications();
  return ok({ state: res.loan.state });
}

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

const requestSchema = z.object({
  copyId: uuid,
  handoffMethod: z.enum(["meetup", "courier"]),
  dropPointId: uuid.optional().nullable(),
});

export async function requestCopy(
  input: z.input<typeof requestSchema>,
): Promise<ActionResult<{ loanId: string }>> {
  const member = await requireOnboardedMember();
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return err("invalid", "Choose how you'd like to receive the book.");
  const db = getDb();
  const config = await loadConfig(db);
  const res = await createLoanRequest(
    db,
    { ...parsed.data, borrowerId: member.id },
    actorOf(member),
    config,
  );
  if (!res.ok) return err(res.error.code, res.error.message);
  track(member.id, "loan_requested", { loanId: res.loan.id, handoff: parsed.data.handoffMethod });
  revalidateLoan(res.loan.id);
  await flushNotifications();
  revalidatePath(`/b/${res.loan.bookId}`);
  return ok({ loanId: res.loan.id });
}

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

export async function acceptRequest(loanId: string, inHandConfirmed: boolean) {
  const member = await requireOnboardedMember();
  if (!uuid.safeParse(loanId).success) return err("invalid", "Bad loan id.");
  return apply(
    member,
    loanId,
    { type: "accept", inHandConfirmed: Boolean(inHandConfirmed) },
    "loan_accepted",
  );
}

export async function declineRequest(
  loanId: string,
  reason: "not_available" | "no_longer_have" | "other",
) {
  const member = await requireOnboardedMember();
  const r = z.enum(["not_available", "no_longer_have", "other"]).safeParse(reason);
  if (!uuid.safeParse(loanId).success || !r.success) return err("invalid", "Pick a reason.");
  return apply(member, loanId, { type: "decline", reason: r.data }, "loan_declined");
}

export async function extendLoan(loanId: string) {
  const member = await requireOnboardedMember();
  if (!uuid.safeParse(loanId).success) return err("invalid", "Bad loan id.");
  return apply(member, loanId, { type: "extend" }, "loan_extended");
}

// ---------------------------------------------------------------------------
// handoff and return
// ---------------------------------------------------------------------------

export async function confirmHandoffWithPhoto(loanId: string, photoPath: string) {
  const member = await requireOnboardedMember();
  if (!uuid.safeParse(loanId).success) return err("invalid", "Bad loan id.");
  const photo = await verifyUploadedPhoto("handoff_out", photoPath, member.id);
  if (!photo.ok) return err("photo_invalid", "The photo didn't upload. Please retake it.");
  return apply(member, loanId, { type: "confirm_out", photoPath }, "loan_handed_off");
}

export async function confirmHandoffWithCode(loanId: string, rawCode: string) {
  const member = await requireOnboardedMember();
  const c = code.safeParse(rawCode);
  if (!uuid.safeParse(loanId).success) return err("invalid", "Bad loan id.");
  if (!c.success) return err("invalid_code", c.error.issues[0].message);
  return apply(member, loanId, { type: "confirm_out", code: c.data }, "loan_handed_off");
}

export async function confirmReturnWithPhoto(
  loanId: string,
  photoPath: string,
  returnCondition?: "like_new" | "good" | "worn",
) {
  const member = await requireOnboardedMember();
  if (!uuid.safeParse(loanId).success) return err("invalid", "Bad loan id.");
  const cond = returnCondition === undefined ? undefined : condition.safeParse(returnCondition);
  if (cond && !cond.success) return err("invalid", "Pick the condition.");
  const photo = await verifyUploadedPhoto("handoff_return", photoPath, member.id);
  if (!photo.ok) return err("photo_invalid", "The photo didn't upload. Please retake it.");
  return apply(
    member,
    loanId,
    { type: "confirm_return", photoPath, condition: cond?.data },
    "loan_returned",
  );
}

export async function confirmReturnWithCode(
  loanId: string,
  rawCode: string,
  returnCondition?: "like_new" | "good" | "worn",
) {
  const member = await requireOnboardedMember();
  const c = code.safeParse(rawCode);
  if (!uuid.safeParse(loanId).success) return err("invalid", "Bad loan id.");
  if (!c.success) return err("invalid_code", c.error.issues[0].message);
  const cond = returnCondition === undefined ? undefined : condition.safeParse(returnCondition);
  if (cond && !cond.success) return err("invalid", "Pick the condition.");
  return apply(
    member,
    loanId,
    { type: "confirm_return", code: c.data, condition: cond?.data },
    "loan_returned",
  );
}

// ---------------------------------------------------------------------------
// dispute
// ---------------------------------------------------------------------------

export async function openDispute(loanId: string, reason: string) {
  const member = await requireOnboardedMember();
  const r = z
    .string()
    .trim()
    .min(20, "Describe the problem in at least 20 characters.")
    .max(1000)
    .safeParse(reason);
  if (!uuid.safeParse(loanId).success) return err("invalid", "Bad loan id.");
  if (!r.success) return err("invalid", r.error.issues[0].message);
  return apply(member, loanId, { type: "dispute", reason: r.data }, "dispute_opened");
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

export type ChatMessage = { id: string; senderId: string; body: string; at: string };

export async function sendMessage(
  loanId: string,
  body: string,
): Promise<ActionResult<ChatMessage>> {
  const member = await requireOnboardedMember();
  const b = z
    .string()
    .trim()
    .min(1)
    .max(500, "Keep messages under 500 characters.")
    .safeParse(body);
  if (!uuid.safeParse(loanId).success) return err("invalid", "Bad loan id.");
  if (!b.success) return err("invalid", b.error.issues[0].message);
  const res = await sendLoanMessage(getDb(), { loanId, senderId: member.id, body: b.data });
  if (!res.ok) {
    const messages = {
      not_found: "This loan no longer exists.",
      not_a_party: "You're not part of this loan.",
      chat_closed: "Chat is closed for this loan.",
    };
    return err(res.error, messages[res.error]);
  }
  return ok({
    id: res.message.id,
    senderId: res.message.senderId,
    body: res.message.body,
    at: res.message.createdAt.toISOString(),
  });
}

export async function fetchMessages(
  loanId: string,
  sinceIso: string | null,
): Promise<ActionResult<ChatMessage[]>> {
  const member = await requireOnboardedMember();
  if (!uuid.safeParse(loanId).success) return err("invalid", "Bad loan id.");
  const db = getDb();
  if (!member.isAdmin && !(await isLoanParty(db, loanId, member.id)))
    return err("not_a_party", "You're not part of this loan.");
  const rows = await listMessagesSince(db, loanId, sinceIso ? new Date(sinceIso) : null);
  return ok(
    rows.map((m) => ({ id: m.id, senderId: m.senderId, body: m.body, at: m.at.toISOString() })),
  );
}
