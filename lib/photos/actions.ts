"use server";

import { z } from "zod";
import { err, ok, type ActionResult } from "@/lib/actions/result";
import { requireMember } from "@/lib/auth/current-member";
import { createSignedUpload, type PhotoPurpose, type SignedUpload } from "./storage";

const purposeSchema = z.enum(["listing", "review", "handoff_out", "handoff_return"]);

/** Called by PhotoCapture right before it PUTs the processed JPEG to Storage. */
export async function createUploadUrl(purpose: PhotoPurpose): Promise<ActionResult<SignedUpload>> {
  const parsed = purposeSchema.safeParse(purpose);
  if (!parsed.success) return err("invalid_purpose", "Unknown photo purpose.");
  const member = await requireMember();
  try {
    return ok(await createSignedUpload(parsed.data, member.id));
  } catch (e) {
    console.error("createUploadUrl failed", e);
    return err(
      "upload_url_failed",
      "Couldn't prepare the upload. Check your connection and try again.",
    );
  }
}
