import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/db/schema";

export type TestDb = PgliteDatabase<typeof schema>;

/**
 * Fresh in-memory Postgres (PGlite) with every migration applied.
 * Each call returns an isolated database, so tests never share state.
 */
export async function createTestDb(): Promise<{ db: TestDb; close: () => Promise<void> }> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../db/migrations") });
  return { db, close: () => client.close() };
}

/**
 * Drizzle wraps driver errors as "Failed query: ..." with the Postgres error in
 * `cause`. Assert on the constraint name wherever it appears.
 */
export async function expectDbError(promise: Promise<unknown>, constraint: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (!caught) throw new Error(`expected a database error mentioning ${constraint}`);
  const parts: string[] = [];
  let e: unknown = caught;
  while (e && typeof e === "object") {
    const rec = e as { message?: string; constraint?: string; cause?: unknown };
    if (rec.message) parts.push(rec.message);
    if (rec.constraint) parts.push(rec.constraint);
    e = rec.cause;
  }
  if (!parts.some((p) => p.includes(constraint))) {
    throw new Error(`expected error mentioning ${constraint}, got: ${parts.join(" | ")}`);
  }
}
