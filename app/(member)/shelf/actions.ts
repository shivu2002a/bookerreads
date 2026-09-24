"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { err, fieldErrors, ok, type ActionResult } from "@/lib/actions/result";
import { track } from "@/lib/analytics/server";
import { requireOnboardedMember } from "@/lib/auth/current-member";
import { loadConfig } from "@/lib/config/load";
import { createCopy, createManualBook } from "@/lib/copies/create";
import { relistCopy, unlistCopy, updateCopyDetails } from "@/lib/copies/manage";
import { copyDetailsSchema } from "@/lib/copies/schema";
import { verifyUploadedPhoto } from "@/lib/photos/storage";

const uuid = z.uuid();

/** FormData carries allowedHandoffs as repeated fields; normalise before Zod. */
function formToDetails(formData: FormData) {
  return {
    condition: formData.get("condition"),
    replacementValuePaise: formData.get("replacementValuePaise"),
    rentalPricePaise: formData.get("rentalPricePaise") ?? 0,
    loanPeriodDays: formData.get("loanPeriodDays") ?? 21,
    allowedHandoffs: formData.getAll("allowedHandoffs"),
    minBorrowerTrust: formData.get("minBorrowerTrust") ?? 0,
    notes: formData.get("notes") ?? "",
  };
}

export type CreateCopyActionResult = ActionResult<{ copyId: string }>;

export async function createCopyAction(
  _prev: unknown,
  formData: FormData,
): Promise<CreateCopyActionResult> {
  const member = await requireOnboardedMember();
  const details = copyDetailsSchema.safeParse(formToDetails(formData));
  const bookId = uuid.safeParse(formData.get("bookId"));
  const photoPath = z
    .string()
    .min(1, "Take a photo of the book.")
    .safeParse(formData.get("photoPath"));

  const fields: Record<string, string> = {};
  if (!details.success) Object.assign(fields, fieldErrors(details.error.issues));
  if (!bookId.success) fields.bookId = "Pick a book first.";
  if (!photoPath.success) fields.photoPath = photoPath.error.issues[0].message;
  if (Object.keys(fields).length) return err("invalid", "Check the highlighted fields.", fields);

  const photo = await verifyUploadedPhoto("listing", photoPath.data!, member.id);
  if (!photo.ok)
    return err("photo_invalid", "The photo didn't upload properly. Please retake it.", {
      photoPath: "Retake the photo",
    });

  const db = getDb();
  const config = await loadConfig(db);
  const res = await createCopy(
    db,
    {
      ...details.data!,
      ownerId: member.id,
      bookId: bookId.data!,
      listingPhotoPath: photoPath.data!,
    },
    config,
  );
  if (!res.ok) {
    switch (res.error.code) {
      case "listing_cap_reached":
        return err(
          "cap",
          `New accounts can list up to ${res.error.cap} books in their first ${res.error.ageDays} days. You can add more soon.`,
        );
      case "book_not_found":
        return err("book_not_found", "That book isn't in the catalogue any more. Scan it again.");
      case "member_not_onboarded":
        return err("not_onboarded", "Finish setting up your profile first.");
    }
  }
  track(member.id, "copy_listed", { bookId: bookId.data! });
  revalidatePath("/shelf");
  return ok({ copyId: res.copy.id });
}

const manualBookSchema = z.object({
  title: z.string().trim().min(1, "Enter the title.").max(200),
  authors: z.string().trim().min(1, "Enter at least one author.").max(200),
  language: z.string().trim().length(2).default("en"),
  reviewPhotoPath: z.string().min(1, "Photograph the title page."),
});

export type ManualBookResult = ActionResult<{ bookId: string; title: string }>;

export async function createManualBookAction(
  _prev: unknown,
  formData: FormData,
): Promise<ManualBookResult> {
  const member = await requireOnboardedMember();
  const parsed = manualBookSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success)
    return err("invalid", "Check the highlighted fields.", fieldErrors(parsed.error.issues));

  const photo = await verifyUploadedPhoto("review", parsed.data.reviewPhotoPath, member.id);
  if (!photo.ok)
    return err("photo_invalid", "The title-page photo didn't upload. Please retake it.", {
      reviewPhotoPath: "Retake the photo",
    });

  const book = await createManualBook(getDb(), {
    title: parsed.data.title,
    authors: parsed.data.authors
      .split(/[,;]/)
      .map((a) => a.trim())
      .filter(Boolean),
    language: parsed.data.language,
    reviewPhotoPath: parsed.data.reviewPhotoPath,
    createdBy: member.id,
  });
  return ok({ bookId: book.id, title: book.title });
}

const MANAGE_MESSAGES: Record<string, string> = {
  not_found: "That copy no longer exists.",
  not_owner: "That copy isn't on your shelf.",
  on_loan: "You can't unlist a book while it's requested or on loan.",
  not_unlisted: "That copy is already in that state.",
};

export async function unlistCopyAction(copyId: string): Promise<ActionResult> {
  const member = await requireOnboardedMember();
  const id = uuid.safeParse(copyId);
  if (!id.success) return err("invalid", "Bad copy id.");
  const res = await unlistCopy(getDb(), id.data, member.id);
  if (!res.ok) return err(res.error, MANAGE_MESSAGES[res.error]);
  track(member.id, "copy_unlisted", { copyId: id.data });
  revalidatePath("/shelf");
  return ok();
}

export async function relistCopyAction(copyId: string): Promise<ActionResult> {
  const member = await requireOnboardedMember();
  const id = uuid.safeParse(copyId);
  if (!id.success) return err("invalid", "Bad copy id.");
  const res = await relistCopy(getDb(), id.data, member.id);
  if (!res.ok) return err(res.error, MANAGE_MESSAGES[res.error]);
  revalidatePath("/shelf");
  return ok();
}

export async function updateCopyAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const member = await requireOnboardedMember();
  const id = uuid.safeParse(formData.get("copyId"));
  const details = copyDetailsSchema.safeParse(formToDetails(formData));
  if (!id.success) return err("invalid", "Bad copy id.");
  if (!details.success)
    return err("invalid", "Check the highlighted fields.", fieldErrors(details.error.issues));
  const db = getDb();
  const res = await updateCopyDetails(db, id.data, member.id, details.data, await loadConfig(db));
  if (!res.ok) return err(res.error, MANAGE_MESSAGES[res.error]);
  revalidatePath("/shelf");
  return ok();
}
