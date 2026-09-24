import { getPublicEnv } from "@/lib/env";

/** Public URL for a listing photo path. Safe on client and server. */
export function listingPhotoUrl(path: string): string {
  const base = getPublicEnv().NEXT_PUBLIC_SUPABASE_URL;
  return `${base}/storage/v1/object/public/listing-photos/${path}`;
}
