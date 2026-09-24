import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

/**
 * Service-role client. Bypasses Row Level Security.
 *
 * Only for server-side domain logic that must write across members (loan
 * transitions, ledger entries, notifications) and for Storage signed URLs.
 * The `server-only` import makes any client bundle that pulls this in fail
 * at build time, and ESLint restricts where it may be imported from.
 */
let client: SupabaseClient | undefined;

export function getSupabaseServiceClient(): SupabaseClient {
  if (!client) {
    const env = getServerEnv();
    client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Realtime is unused server-side and needs a global WebSocket (absent on Node 20).
      realtime: { transport: class {} as never },
    });
  }
  return client;
}
