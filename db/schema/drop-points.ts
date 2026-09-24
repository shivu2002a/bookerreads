import { boolean, index, jsonb, pgTable, smallint, text, uuid } from "drizzle-orm/pg-core";
import { baseColumns } from "./_shared";
import { clusters } from "./clusters";

export type DropPointHours = Record<
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
  { open: string; close: string } | null
>;

/** Partner venue holding a shelf for handoffs (Requirement 12). */
export const dropPoints = pgTable(
  "drop_points",
  {
    ...baseColumns,
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id),
    name: text("name").notNull(),
    address: text("address").notNull(),
    contact: text("contact").notNull(),
    hours: jsonb("hours").$type<DropPointHours>().notNull(),
    capacity: smallint("capacity").notNull(),
    occupancy: smallint("occupancy").notNull().default(0),
    /** Embedded in the poster QR; rotating it invalidates printed posters. */
    qrSecret: text("qr_secret").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("drop_points_cluster_active_idx").on(t.clusterId, t.active)],
);
