import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { members } from "@/db/schema";
import { getServerEnv } from "@/lib/env";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { interaktProvider, mockProviders, msg91Provider } from "./providers";
import { dispatchQueued, type NotifyDeps } from "./send";

let deps: NotifyDeps | undefined;

/** Phone numbers live only in Supabase Auth; look them up per member id. */
async function phoneFor(memberId: string): Promise<string | null> {
  const [m] = await getDb()
    .select({ authUserId: members.authUserId })
    .from(members)
    .where(eq(members.id, memberId));
  if (!m) return null;
  const { data } = await getSupabaseServiceClient().auth.admin.getUserById(m.authUserId);
  return data.user?.phone?.replace(/^\+/, "") ?? null;
}

export function getNotifyDeps(): NotifyDeps {
  if (deps) return deps;
  const env = getServerEnv();
  const providers =
    env.NOTIFY_MODE === "mock"
      ? mockProviders()
      : {
          whatsapp: interaktProvider({ apiKey: env.INTERAKT_API_KEY }),
          sms: msg91Provider({ authKey: env.MSG91_AUTH_KEY, senderId: env.MSG91_SENDER_ID }),
        };
  deps = {
    ...providers,
    phoneFor,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    log: (msg, meta) => console.warn(msg, meta),
  };
  return deps;
}

/**
 * Call after a transaction that queued notifications has committed. Never
 * throws: a provider outage must not fail the user's action; the cron sweep
 * picks up anything still queued.
 */
export async function flushNotifications(): Promise<void> {
  try {
    await dispatchQueued(getDb(), getNotifyDeps());
  } catch (err) {
    console.error("notification dispatch failed", err);
  }
}

export { dispatchQueued, enqueue, recordDeliveryStatus, sweepUndelivered } from "./send";
