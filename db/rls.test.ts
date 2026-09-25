import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { seed } from "./seed/run";

/**
 * Exercises the policies in 0001_rls.sql against a seeded PGlite database by
 * switching to the anon/authenticated roles and setting the JWT claim,
 * exactly as PostgREST does for a Supabase client.
 */

let db: TestDb;
let close: () => Promise<void>;

type MemberRow = { id: string; auth_user_id: string; display_name: string; is_admin: boolean };
let admin: MemberRow;
let lender: MemberRow;
let borrower: MemberRow;
let outsider: MemberRow;
let loanId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seed(db, { now: new Date("2026-09-21T10:00:00Z") });

  const members = (
    await db.execute<MemberRow>(
      sql`select id, auth_user_id, display_name, is_admin from members where deleted_at is null`,
    )
  ).rows;
  admin = members.find((m) => m.is_admin)!;

  const loan = (
    await db.execute<{ id: string; lender_id: string; borrower_id: string }>(
      sql`select id, lender_id, borrower_id from loans where state = 'on_loan' limit 1`,
    )
  ).rows[0];
  loanId = loan.id;
  lender = members.find((m) => m.id === loan.lender_id)!;
  borrower = members.find((m) => m.id === loan.borrower_id)!;
  outsider = members.find(
    (m) => !m.is_admin && m.id !== loan.lender_id && m.id !== loan.borrower_id,
  )!;
}, 60_000);
afterAll(() => close());

/** Run `query` as the given role (and auth user), then restore superuser. */
async function as<T extends Record<string, unknown> = Record<string, unknown>>(
  role: "anon" | "authenticated",
  authUserId: string | null,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  await db.execute(sql.raw(`set role ${role}`));
  await db.execute(
    sql`select set_config('request.jwt.claims', ${authUserId ? JSON.stringify({ sub: authUserId, role }) : ""}, false)`,
  );
  try {
    return (await db.execute(query)).rows as T[];
  } finally {
    await db.execute(sql.raw("reset role"));
    await db.execute(sql`select set_config('request.jwt.claims', '', false)`);
  }
}

async function asFails(
  role: "anon" | "authenticated",
  authUserId: string | null,
  query: ReturnType<typeof sql>,
): Promise<string> {
  try {
    await as(role, authUserId, query);
  } catch (err) {
    await db.execute(sql.raw("reset role"));
    return String(
      (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message,
    );
  }
  throw new Error("expected the query to be rejected");
}

describe("RLS: reference data", () => {
  it("anon can read clusters, books, and active drop points", async () => {
    expect((await as("anon", null, sql`select id from clusters`)).length).toBe(3);
    expect((await as("anon", null, sql`select id from books`)).length).toBeGreaterThan(200);
    expect((await as("anon", null, sql`select id, name from drop_points`)).length).toBe(2);
  });

  it("anon cannot read drop point QR secrets", async () => {
    const msg = await asFails("anon", null, sql`select qr_secret from drop_points`);
    expect(msg).toMatch(/permission denied/);
  });
});

describe("RLS: members", () => {
  it("a member sees only their own members row", async () => {
    const rows = await as<{ id: string }>(
      "authenticated",
      lender.auth_user_id,
      sql`select id from members`,
    );
    expect(rows.map((r) => r.id)).toEqual([lender.id]);
  });

  it("anon sees no members rows at all", async () => {
    expect(await as("anon", null, sql`select id from members`)).toEqual([]);
  });

  it("an admin sees every member", async () => {
    const rows = await as("authenticated", admin.auth_user_id, sql`select id from members`);
    expect(rows.length).toBe(30);
  });

  it("member_public exposes names and trust but not phone hash or balances", async () => {
    const rows = await as<Record<string, unknown>>(
      "anon",
      null,
      sql`select * from member_public limit 1`,
    );
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["can_borrow", "cluster_id", "display_name", "id", "member_since", "trust_score"].sort(),
    );
    const all = await as("anon", null, sql`select id from member_public`);
    expect(all.length).toBe(30);
  });
});

describe("RLS: copies", () => {
  it("anon sees listed copies but not unlisted ones", async () => {
    const rows = await as<{ availability: string }>(
      "anon",
      null,
      sql`select distinct availability from copies`,
    );
    expect(rows.map((r) => r.availability).sort()).toEqual(["available", "on_loan"]);
  });

  it("an owner also sees their own unlisted and requested copies", async () => {
    const owner = (
      await db.execute<{ owner_id: string }>(
        sql`select owner_id from copies where availability = 'unlisted' limit 1`,
      )
    ).rows[0].owner_id;
    const auth = (
      await db.execute<{ auth_user_id: string }>(
        sql`select auth_user_id from members where id = ${owner}`,
      )
    ).rows[0].auth_user_id;
    const rows = await as<{ id: string }>(
      "authenticated",
      auth,
      sql`select id from copies where owner_id = ${owner} and availability = 'unlisted'`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("RLS: loans and attachments", () => {
  it("lender and borrower can read the loan; an outsider cannot", async () => {
    const q = sql`select id from loans where id = ${loanId}`;
    expect(await as("authenticated", lender.auth_user_id, q)).toHaveLength(1);
    expect(await as("authenticated", borrower.auth_user_id, q)).toHaveLength(1);
    expect(await as("authenticated", outsider.auth_user_id, q)).toHaveLength(0);
    expect(await as("anon", null, q)).toHaveLength(0);
  });

  it("loan photos and chat follow the loan", async () => {
    const photos = sql`select id from loan_photos where loan_id = ${loanId}`;
    const chat = sql`select id from loan_messages where loan_id = ${loanId}`;
    expect((await as("authenticated", borrower.auth_user_id, photos)).length).toBeGreaterThan(0);
    expect((await as("authenticated", borrower.auth_user_id, chat)).length).toBeGreaterThan(0);
    expect(await as("authenticated", outsider.auth_user_id, photos)).toHaveLength(0);
    expect(await as("authenticated", outsider.auth_user_id, chat)).toHaveLength(0);
  });

  it("chat closes 48 hours after return, but stays open to admins", async () => {
    const old = (
      await db.execute<{ id: string; lender_id: string }>(
        sql`select id, lender_id from loans where state = 'returned' and returned_at < now() - interval '3 days' limit 1`,
      )
    ).rows[0];
    const auth = (
      await db.execute<{ auth_user_id: string }>(
        sql`select auth_user_id from members where id = ${old.lender_id}`,
      )
    ).rows[0].auth_user_id;
    const chat = sql`select id from loan_messages where loan_id = ${old.id}`;
    // The lender is a party, so the loan itself is still visible ...
    expect(
      await as("authenticated", auth, sql`select id from loans where id = ${old.id}`),
    ).toHaveLength(1);
    // ... but the chat is not.
    expect(await as("authenticated", auth, chat)).toHaveLength(0);
    expect((await as("authenticated", admin.auth_user_id, chat)).length).toBeGreaterThan(0);
  });

  it("an admin sees every loan", async () => {
    const all = Number(
      (await db.execute<{ n: string }>(sql`select count(*)::text as n from loans`)).rows[0].n,
    );
    expect(await as("authenticated", admin.auth_user_id, sql`select id from loans`)).toHaveLength(
      all,
    );
  });
});

describe("RLS: money and trust", () => {
  it("ledger entries are visible to their member and admins only", async () => {
    const someone = (
      await db.execute<{ member_id: string }>(
        sql`select member_id from ledger_entries where kind = 'rental_credit' limit 1`,
      )
    ).rows[0].member_id;
    const auth = (
      await db.execute<{ auth_user_id: string }>(
        sql`select auth_user_id from members where id = ${someone}`,
      )
    ).rows[0].auth_user_id;
    const own = await as<{ member_id: string }>(
      "authenticated",
      auth,
      sql`select distinct member_id from ledger_entries`,
    );
    expect(own.map((r) => r.member_id)).toEqual([someone]);
    expect(await as("anon", null, sql`select id from ledger_entries`)).toHaveLength(0);
  });

  it("config, events, admin actions, and webhook events are admin-only", async () => {
    for (const table of ["config", "events", "admin_actions", "webhook_events"]) {
      const q = sql.raw(`select 1 from ${table} limit 1`);
      expect(await as("authenticated", lender.auth_user_id, q), table).toHaveLength(0);
    }
    expect(
      (await as("authenticated", admin.auth_user_id, sql`select 1 from config`)).length,
    ).toBeGreaterThan(0);
  });
});

describe("RLS: no client writes", () => {
  it("authenticated members cannot insert, update, or delete", async () => {
    expect(
      await asFails(
        "authenticated",
        lender.auth_user_id,
        sql`update members set display_name = 'x' where id = ${lender.id}`,
      ),
    ).toMatch(/permission denied/);
    expect(
      await asFails(
        "authenticated",
        borrower.auth_user_id,
        sql`insert into loan_messages (loan_id, sender_id, body) values (${loanId}, ${borrower.id}, 'hi')`,
      ),
    ).toMatch(/permission denied/);
    expect(await asFails("authenticated", admin.auth_user_id, sql`delete from config`)).toMatch(
      /permission denied/,
    );
  });
});
