import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Driver-agnostic database types. Production uses postgres-js; tests use
 * PGlite. Domain code in lib/ is written against these so it runs on both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<PgQueryResultHKT, typeof schema, any>;
export type Tx = PgTransaction<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
export type DbOrTx = Db | Tx;

let db: Db | undefined;

/**
 * Drizzle over the direct Postgres connection. Used by domain logic in lib/
 * for transactional writes (row locks, ledger, events) that Supabase's
 * PostgREST client cannot express. Serverless-friendly: small pool, prepared
 * statements off (Supabase's pooler runs in transaction mode).
 */
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const client = postgres(url, { max: 5, prepare: false, idle_timeout: 20 });
    db = drizzle(client, { schema, casing: "snake_case" });
  }
  return db;
}

/** postgres-js returns an array from execute(); PGlite returns `{ rows }`. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows: T[] }).rows;
}

export { schema };
