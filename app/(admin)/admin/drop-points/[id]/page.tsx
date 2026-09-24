import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { clusters } from "@/db/schema";
import { getDropPoint } from "@/lib/admin/drop-points";
import { when } from "../../_components/fmt";
import { SimpleButton } from "../../_components/simple-button";
import { rotateSecretAction } from "../../actions";
import { DropPointForm } from "../drop-point-form";

export default async function AdminDropPointPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const [dp, clusterRows] = await Promise.all([
    getDropPoint(db, id),
    db.select({ id: clusters.id, name: clusters.name }).from(clusters).orderBy(clusters.name),
  ]);
  if (!dp) notFound();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{dp.name}</h1>
          <p className="text-muted-foreground text-sm">
            {dp.address} · occupancy {dp.occupancy}/{dp.capacity} ·{" "}
            {dp.active ? "active" : "inactive"}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/print/drop-point/${dp.id}`}
            target="_blank"
            className="h-8 rounded-md border px-3 text-sm leading-8"
          >
            Print poster
          </Link>
          <SimpleButton
            label="Rotate QR secret"
            action={(reason) => rotateSecretAction(dp.id, reason)}
            promptReason="Why rotate? Existing posters stop working."
            variant="destructive"
          />
        </div>
      </header>

      <section>
        <h2 className="text-muted-foreground mb-1 text-sm font-medium">
          On the shelf now · {dp.shelf.length}
        </h2>
        {dp.shelf.length ? (
          <ul className="divide-y rounded-lg border text-sm">
            {dp.shelf.map((s) => (
              <li key={s.loanId} className="px-3 py-1.5">
                <Link href={`/admin/loans/${s.loanId}`} className="underline">
                  {s.title}
                </Link>{" "}
                · since {when.format(new Date(s.since))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">Empty.</p>
        )}
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="mb-3 font-medium">Edit</h2>
        <DropPointForm
          clusters={clusterRows}
          existing={{
            id: dp.id,
            clusterId: dp.clusterId,
            name: dp.name,
            address: dp.address,
            contact: dp.contact,
            capacity: dp.capacity,
            hours: dp.hours,
            active: dp.active,
          }}
        />
      </section>
    </div>
  );
}
