import { desc } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/db/client";
import { adminActions, config as configTable, members } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CONFIG_DESCRIPTIONS, configSchemas, type ConfigKey } from "@/lib/config/schema";
import { when } from "./_components/fmt";
import { ConfigEditor } from "./config-editor";

export default async function AdminOverviewPage() {
  const db = getDb();
  const [rows, recent] = await Promise.all([
    db.select().from(configTable),
    db
      .select({
        action: adminActions.action,
        reason: adminActions.reason,
        at: adminActions.createdAt,
        targetType: adminActions.targetType,
        targetId: adminActions.targetId,
        admin: members.displayName,
      })
      .from(adminActions)
      .innerJoin(members, eq(members.id, adminActions.adminId))
      .orderBy(desc(adminActions.createdAt))
      .limit(30),
  ]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const keys = Object.keys(configSchemas) as ConfigKey[];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Overview</h1>
      <section>
        <h2 className="text-muted-foreground mb-1 text-sm font-medium">Recent admin actions</h2>
        <ul className="divide-y rounded-lg border text-sm">
          {recent.map((a, i) => (
            <li key={i} className="px-3 py-1.5">
              <span className="font-medium">{a.action}</span> by {a.admin} · {a.reason} ·{" "}
              <Link
                href={
                  a.targetType === "member"
                    ? `/admin/members/${a.targetId}`
                    : a.targetType === "loan"
                      ? `/admin/loans/${a.targetId}`
                      : "#"
                }
                className="underline"
              >
                {a.targetType}
              </Link>{" "}
              · {when.format(a.at)}
            </li>
          ))}
          {recent.length === 0 && <li className="text-muted-foreground px-3 py-1.5">None yet.</li>}
        </ul>
      </section>
      <section>
        <h2 className="text-muted-foreground mb-1 text-sm font-medium">
          Configuration (live; no deploy needed)
        </h2>
        <ConfigEditor
          entries={keys.map((k) => ({
            key: k,
            description: CONFIG_DESCRIPTIONS[k],
            value: JSON.stringify(byKey.get(k)?.value ?? null, null, 2),
            updatedAt: byKey.get(k)?.updatedAt?.toISOString() ?? null,
          }))}
        />
      </section>
    </div>
  );
}
