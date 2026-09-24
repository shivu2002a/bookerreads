/**
 * Reconciles cached member balances against ledger sums and reports
 * deposit liability separately from revenue (Requirement 15.4).
 *
 *   pnpm ledger:check          # report; exit 1 on any mismatch
 *   pnpm ledger:check --fix    # also rewrite cached balances from the ledger
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";

config({ path: ".env.local" });
config({ path: ".env" });

type Row = {
  id: string;
  display_name: string | null;
  deposit_cached: number;
  deposit_ledger: number;
  payout_cached: number;
  payout_ledger: number;
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  const fix = process.argv.includes("--fix");

  const rows = (await db.execute<Row>(sql`
    select m.id, m.display_name,
      m.deposit_balance_paise as deposit_cached,
      coalesce((select sum(amount_paise) from ledger_entries e where e.member_id = m.id and e.account = 'deposit'), 0)::int as deposit_ledger,
      m.payout_balance_paise as payout_cached,
      coalesce((select sum(amount_paise) from ledger_entries e where e.member_id = m.id and e.account = 'payout'), 0)::int as payout_ledger
    from members m`)) as unknown as Row[];

  const mismatches = rows.filter(
    (r) =>
      Number(r.deposit_cached) !== Number(r.deposit_ledger) ||
      Number(r.payout_cached) !== Number(r.payout_ledger),
  );
  const negatives = rows.filter((r) => Number(r.deposit_ledger) < 0 || Number(r.payout_ledger) < 0);

  const totals = rows.reduce(
    (a, r) => ({
      deposit: a.deposit + Number(r.deposit_ledger),
      payout: a.payout + Number(r.payout_ledger),
    }),
    { deposit: 0, payout: 0 },
  );
  const [rev] = (await db.execute<{ revenue: number }>(
    sql`select coalesce(sum(amount_paise),0)::int as revenue from subscription_payments where status = 'captured'`,
  )) as unknown as Array<{ revenue: number }>;
  const [pool] = (await db.execute<{ credited: number; paid: number }>(sql`
    select coalesce(sum(case when kind = 'pool_credit' then amount_paise end),0)::int as credited,
           coalesce(-sum(case when kind = 'payout_out' then amount_paise end),0)::int as paid
    from ledger_entries`)) as unknown as Array<{ credited: number; paid: number }>;

  const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  console.log(`Members: ${rows.length}`);
  console.log(`Deposit liability (held, owed back to members): ${inr(totals.deposit)}`);
  console.log(`Payout liability (earned, not yet paid):        ${inr(totals.payout)}`);
  console.log(`Subscription revenue captured (all time):       ${inr(Number(rev.revenue))}`);
  console.log(
    `Pool credited / paid out:                        ${inr(Number(pool.credited))} / ${inr(Number(pool.paid))}`,
  );

  if (negatives.length) {
    console.error(`\n${negatives.length} member(s) with a negative ledger balance:`);
    for (const r of negatives)
      console.error(
        `  ${r.id} ${r.display_name ?? ""} deposit=${r.deposit_ledger} payout=${r.payout_ledger}`,
      );
  }
  if (mismatches.length) {
    console.error(`\n${mismatches.length} cached balance mismatch(es):`);
    for (const r of mismatches) {
      console.error(
        `  ${r.id} ${r.display_name ?? ""} deposit cached=${r.deposit_cached} ledger=${r.deposit_ledger} | payout cached=${r.payout_cached} ledger=${r.payout_ledger}`,
      );
    }
    if (fix) {
      await db.execute(sql`
        update members m set
          deposit_balance_paise = coalesce((select sum(amount_paise) from ledger_entries e where e.member_id = m.id and e.account = 'deposit'), 0),
          payout_balance_paise  = coalesce((select sum(amount_paise) from ledger_entries e where e.member_id = m.id and e.account = 'payout'), 0)`);
      console.log("Cached balances rewritten from the ledger.");
    }
  } else {
    console.log("\nAll cached balances match the ledger.");
  }
  await client.end();
  process.exit(mismatches.length || negatives.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
