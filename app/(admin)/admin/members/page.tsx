import Link from "next/link";
import { getDb } from "@/db/client";
import { searchMembers } from "@/lib/admin/members";
import { formatPaise } from "@/lib/money";
import { day } from "../_components/fmt";

export default async function AdminMembersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const rows = await searchMembers(getDb(), q);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Members</h1>
      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Phone number or display name"
          className="bg-background h-9 w-80 rounded-md border px-3 text-sm"
        />
        <button className="h-9 rounded-md border px-3 text-sm">Search</button>
      </form>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-1">Name</th>
            <th>State</th>
            <th>Trust</th>
            <th>Deposit</th>
            <th>Payout</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} className="border-t">
              <td className="py-1.5">
                <Link href={`/admin/members/${m.id}`} className="underline">
                  {m.displayName ?? "(no name)"}
                </Link>
                {m.deletedAt && <span className="text-muted-foreground ml-1 text-xs">deleted</span>}
              </td>
              <td>{m.state}</td>
              <td>{m.trustScore}</td>
              <td>{formatPaise(m.deposit)}</td>
              <td>{formatPaise(m.payout)}</td>
              <td>{day.format(m.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="text-muted-foreground text-sm">No members match.</p>}
    </div>
  );
}
