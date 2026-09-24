import Link from "next/link";
import { getDb } from "@/db/client";
import { searchLoans } from "@/lib/admin/loans";
import { when } from "../_components/fmt";

export default async function AdminLoansPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const rows = await searchLoans(getDb(), q);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Loans</h1>
      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Loan id, member, or book title"
          className="bg-background h-9 w-80 rounded-md border px-3 text-sm"
        />
        <button className="h-9 rounded-md border px-3 text-sm">Search</button>
      </form>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-1">Book</th>
            <th>State</th>
            <th>Lender</th>
            <th>Borrower</th>
            <th>Handoff</th>
            <th>Requested</th>
            <th>Due</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id} className="border-t">
              <td className="py-1.5">
                <Link href={`/admin/loans/${l.id}`} className="underline">
                  {l.title}
                </Link>
              </td>
              <td>{l.state}</td>
              <td>{l.lender}</td>
              <td>{l.borrower}</td>
              <td>{l.handoff}</td>
              <td>{when.format(l.requestedAt)}</td>
              <td>{l.dueAt ? when.format(l.dueAt) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
