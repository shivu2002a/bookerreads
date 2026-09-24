import { safeEqual } from "./constant-time";

export const CRON_SECRET_HEADER = "x-cron-secret";

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; a manual trigger
 * may send `x-cron-secret`. Either is accepted. Compared in constant time.
 */
export function isCronRequestAuthorised(headers: Headers, secret: string): boolean {
  if (!secret) return false;
  const bearer = headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && safeEqual(bearer.slice(7), secret)) return true;
  const custom = headers.get(CRON_SECRET_HEADER);
  return custom !== null && safeEqual(custom, secret);
}

/** Throws a Response-shaped error the route handler can return directly. */
export function assertCronSecret(request: Request, secret: string): Response | null {
  return isCronRequestAuthorised(request.headers, secret)
    ? null
    : new Response("Unauthorized", { status: 401 });
}
