import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import * as schema from "./schema";
import { MEMBERS } from "./seed/data";
import { seed } from "./seed/run";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * When Supabase Auth is reachable (local `supabase start`), create a real auth
 * user per seeded member so the test-OTP numbers in supabase/config.toml log
 * straight into seeded accounts. Otherwise members get random auth ids.
 */
async function ensureAuthUsers(): Promise<Map<string, string> | undefined> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || key === "replace-me") return undefined;

  // Realtime is unused and needs a global WebSocket (absent on Node 20); give it a stub.
  const admin = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: class {} as never },
  });
  const ids = new Map<string, string>();
  const { data: existing, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    console.warn(`Supabase Auth not reachable (${error.message}); skipping auth users`);
    return undefined;
  }
  for (const m of MEMBERS) {
    const found = existing.users.find((u) => u.phone === m.phone);
    if (found) {
      ids.set(m.phone, found.id);
      continue;
    }
    const { data, error: createErr } = await admin.auth.admin.createUser({
      phone: `+${m.phone}`,
      phone_confirm: true,
      user_metadata: { seed: true },
    });
    if (createErr || !data.user) throw createErr ?? new Error("createUser returned no user");
    ids.set(m.phone, data.user.id);
  }
  console.log(`auth users: ${ids.size}`);
  return ids;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PROD_SEED !== "1") {
    throw new Error(
      "Refusing to seed with NODE_ENV=production (set ALLOW_PROD_SEED=1 to override)",
    );
  }

  const authUserIds = await ensureAuthUsers();
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema, casing: "snake_case" });
  const started = Date.now();
  const summary = await seed(db, { authUserIds, log: (m) => console.log(`  ${m}`) });
  console.log(JSON.stringify(summary, null, 2));
  console.log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
