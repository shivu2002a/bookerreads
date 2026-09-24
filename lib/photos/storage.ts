import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * Two buckets (supabase/config.toml):
 * - listing-photos: public-read, unguessable paths. Shown on book pages.
 * - loan-photos: private. Handoff/return evidence, served via signed URLs to
 *   the two parties and admins only.
 */
export const BUCKETS = {
  listing: "listing-photos",
  loan: "loan-photos",
} as const;
export type PhotoBucket = keyof typeof BUCKETS;

export type PhotoPurpose = "listing" | "review" | "handoff_out" | "handoff_return";

const PURPOSE_BUCKET: Record<PhotoPurpose, PhotoBucket> = {
  listing: "listing",
  review: "listing",
  handoff_out: "loan",
  handoff_return: "loan",
};

export function bucketFor(purpose: PhotoPurpose): PhotoBucket {
  return PURPOSE_BUCKET[purpose];
}

/** `${purpose}/${memberId}/${uuid}.jpg`. The uuid makes public paths unguessable. */
export function newPhotoPath(purpose: PhotoPurpose, memberId: string): string {
  return `${purpose}/${memberId}/${randomUUID()}.jpg`;
}

export type SignedUpload = { bucket: string; path: string; token: string; signedUrl: string };

/** Signed PUT URL valid for a couple of minutes; the client uploads directly to Storage. */
export async function createSignedUpload(
  purpose: PhotoPurpose,
  memberId: string,
): Promise<SignedUpload> {
  const bucket = BUCKETS[bucketFor(purpose)];
  const path = newPhotoPath(purpose, memberId);
  const { data, error } = await getSupabaseServiceClient()
    .storage.from(bucket)
    .createSignedUploadUrl(path);
  if (error || !data)
    throw new Error(`createSignedUploadUrl failed: ${error?.message ?? "no data"}`);
  return { bucket, path, token: data.token, signedUrl: data.signedUrl };
}

/** Public URL for a listing photo. */
export function publicPhotoUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl}/storage/v1/object/public/${BUCKETS.listing}/${path}`;
}

/** Short-lived read URL for a private loan photo. */
export async function signedReadUrl(path: string, expiresInSeconds = 300): Promise<string> {
  const { data, error } = await getSupabaseServiceClient()
    .storage.from(BUCKETS.loan)
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw new Error(`createSignedUrl failed: ${error?.message ?? "no data"}`);
  return data.signedUrl;
}

/** Confirms an uploaded object exists and is a reasonably sized JPEG before a row references it. */
export async function verifyUploadedPhoto(
  purpose: PhotoPurpose,
  path: string,
  memberId: string,
): Promise<
  { ok: true } | { ok: false; reason: "wrong_owner" | "missing" | "not_jpeg" | "too_large" }
> {
  if (!path.startsWith(`${purpose}/${memberId}/`)) return { ok: false, reason: "wrong_owner" };
  const bucket = BUCKETS[bucketFor(purpose)];
  const dir = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const { data, error } = await getSupabaseServiceClient()
    .storage.from(bucket)
    .list(dir, { search: name, limit: 1 });
  const obj = data?.find((o) => o.name === name);
  if (error || !obj) return { ok: false, reason: "missing" };
  const meta = obj.metadata as { mimetype?: string; size?: number } | null;
  if (meta?.mimetype && meta.mimetype !== "image/jpeg") return { ok: false, reason: "not_jpeg" };
  if (meta?.size && meta.size > 3 * 1024 * 1024) return { ok: false, reason: "too_large" };
  return { ok: true };
}
