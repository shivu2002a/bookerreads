import type { DbOrTx } from "@/db/client";
import { config as configTable } from "@/db/schema";
import { CONFIG_DEFAULTS, configSchemas, type AppConfig, type ConfigKey } from "./schema";

/**
 * Reads every config row and validates it. A row that fails validation (bad
 * admin edit, stale shape after a deploy) falls back to the default and is
 * reported, so the app keeps running with known-good values.
 */
export async function loadConfig(
  db: DbOrTx,
  onInvalid: (key: string, message: string) => void = (k, m) =>
    console.warn(`config.${k} invalid: ${m}`),
): Promise<AppConfig> {
  const rows = await db
    .select({ key: configTable.key, value: configTable.value })
    .from(configTable);
  const out: AppConfig = structuredClone(CONFIG_DEFAULTS);
  for (const row of rows) {
    const key = row.key as ConfigKey;
    const schema = configSchemas[key];
    if (!schema) continue; // unknown key: ignore
    const parsed = schema.safeParse(row.value);
    if (parsed.success) {
      (out as Record<string, unknown>)[key] = parsed.data;
    } else {
      onInvalid(key, parsed.error.issues.map((i) => i.message).join("; "));
    }
  }
  return out;
}

/** Admin write path: validates before saving. Throws ZodError on bad input. */
export async function setConfigValue<K extends ConfigKey>(
  db: DbOrTx,
  key: K,
  value: unknown,
  updatedBy: string | null,
): Promise<AppConfig[K]> {
  const parsed = configSchemas[key].parse(value) as AppConfig[K];
  await db
    .insert(configTable)
    .values({ key, value: parsed, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: configTable.key,
      set: { value: parsed, updatedBy, updatedAt: new Date() },
    });
  return parsed;
}
