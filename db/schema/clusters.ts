import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns } from "./_shared";
import { clusterStatus } from "./enums";

export const clusters = pgTable("clusters", {
  ...baseColumns,
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  pincodes: text("pincodes").array().notNull().default([]),
  status: clusterStatus("status").notNull().default("waitlist"),
  launchThresholdCopies: integer("launch_threshold_copies").notNull().default(300),
  launchThresholdMembers: integer("launch_threshold_members").notNull().default(60),
});
