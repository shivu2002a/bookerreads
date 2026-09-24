import { createHash } from "node:crypto";

/**
 * sha256 of the E.164 phone. Stable, so admins can look a member up by phone
 * without the app ever storing the number (Requirement 15.2).
 * Server-only: kept apart from lib/auth/phone.ts so client forms can import
 * the formatting helpers without pulling node:crypto into the bundle.
 */
export function hashPhone(e164: string): string {
  return createHash("sha256").update(e164).digest("hex");
}
