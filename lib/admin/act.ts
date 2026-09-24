import type { Db, Tx } from "@/db/client";
import { adminActions } from "@/db/schema";

export class AdminReasonRequired extends Error {
  readonly code = "reason_required";
  constructor() {
    super("Give a reason; it is recorded with the action.");
  }
}

export type AdminTarget = { type: string; id: string };

/**
 * Requirement 15.6: every admin mutation runs inside one transaction with an
 * admin_actions row carrying actor, target, and a non-empty reason. `fn`
 * receives the transaction; if it throws, nothing (including the log row) lands.
 */
export async function adminAction<T>(
  db: Db,
  input: {
    adminId: string;
    target: AdminTarget;
    action: string;
    reason: string;
    payload?: Record<string, unknown>;
  },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new AdminReasonRequired();
  return db.transaction(async (tx) => {
    const result = await fn(tx);
    await tx.insert(adminActions).values({
      adminId: input.adminId,
      targetType: input.target.type,
      targetId: input.target.id,
      action: input.action,
      reason,
      payload: input.payload ?? {},
    });
    return result;
  });
}
