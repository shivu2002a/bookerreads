import Link from "next/link";
import { getDb } from "@/db/client";
import { clusters } from "@/db/schema";
import { listDropPoints } from "@/lib/admin/drop-points";
import { DropPointForm } from "./drop-point-form";

export default async function AdminDropPointsPage() {
  const db = getDb();
  const [rows, clusterRows] = await Promise.all([
    listDropPoints(db),
    db.select({ id: clusters.id, name: clusters.name }).from(clusters).orderBy(clusters.name),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Drop points</h1>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-1">Venue</th>
            <th>Cluster</th>
            <th>Occupancy</th>
            <th>Books on shelf</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ dp, cluster, onShelf }) => (
            <tr key={dp.id} className="border-t">
              <td className="py-1.5">
                <Link href={`/admin/drop-points/${dp.id}`} className="underline">
                  {dp.name}
                </Link>
              </td>
              <td>{cluster}</td>
              <td>
                {dp.occupancy} / {dp.capacity}
              </td>
              <td>{Number(onShelf)}</td>
              <td>{dp.active ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="rounded-lg border p-4">
        <h2 className="mb-3 font-medium">Add a drop point</h2>
        <DropPointForm clusters={clusterRows} />
      </section>
    </div>
  );
}
