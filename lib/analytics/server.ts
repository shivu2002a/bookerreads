import "server-only";
import { PostHog } from "posthog-node";
import { getPublicEnv, getServerEnv } from "@/lib/env";

/**
 * Server-side product analytics. Events carry the member id only: no phone,
 * no display name, no free text (Requirement 15.1). Disabled when no key is set.
 */

export type AnalyticsEvent =
  | "member_registered"
  | "member_onboarded"
  | "copy_listed"
  | "copy_unlisted"
  | "search_performed"
  | "loan_requested"
  | "loan_accepted"
  | "loan_declined"
  | "loan_handed_off"
  | "loan_returned"
  | "loan_extended"
  | "dispute_opened"
  | "member_activated"
  | "rental_paid"
  | "payout_batch_generated";

let client: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (client !== undefined) return client;
  const { NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST } = getPublicEnv();
  if (!NEXT_PUBLIC_POSTHOG_KEY) {
    client = null;
    return client;
  }
  client = new PostHog(NEXT_PUBLIC_POSTHOG_KEY, {
    host: NEXT_PUBLIC_POSTHOG_HOST,
    // Serverless: flush on every capture rather than batching in memory.
    flushAt: 1,
    flushInterval: 0,
  });
  return client;
}

export function track(
  memberId: string,
  event: AnalyticsEvent,
  properties: Record<string, string | number | boolean> = {},
): void {
  const ph = getClient();
  if (!ph) {
    if (getServerEnv().NODE_ENV === "development") {
      console.debug(`[analytics] ${event}`, { memberId, ...properties });
    }
    return;
  }
  ph.capture({ distinctId: memberId, event, properties });
}

export async function flushAnalytics(): Promise<void> {
  await client?.shutdown();
  client = undefined;
}
