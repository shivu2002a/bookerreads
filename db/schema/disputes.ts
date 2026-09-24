import { index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { baseColumns, timestamptz } from "./_shared";
import { disputeResolution, disputeState } from "./enums";
import { loans } from "./loans";
import { members } from "./members";

export const disputes = pgTable(
  "disputes",
  {
    ...baseColumns,
    loanId: uuid("loan_id")
      .notNull()
      .unique()
      .references(() => loans.id),
    openedBy: uuid("opened_by")
      .notNull()
      .references(() => members.id),
    reason: text("reason").notNull(),
    state: disputeState("state").notNull().default("open"),
    resolution: disputeResolution("resolution"),
    chargePaise: integer("charge_paise"),
    resolvedBy: uuid("resolved_by").references(() => members.id),
    resolvedAt: timestamptz("resolved_at"),
    resolutionNote: text("resolution_note"),
  },
  (t) => [index("disputes_state_created_idx").on(t.state, t.createdAt)],
);
