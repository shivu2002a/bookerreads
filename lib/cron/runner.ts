import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { cronRuns, type CronStepResult } from "@/db/schema";

export type Step = { name: string; run: () => Promise<number | void> };

export type CronOutcome = {
  job: "daily" | "monthly";
  runDate: string;
  status: "completed" | "already_ran" | "completed_with_errors";
  steps: CronStepResult[];
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Runs steps in order, each isolated: a failing step is recorded and the run
 * continues (design.md Error Handling). One cron_runs row per (job, date);
 * a second invocation on the same date is a no-op unless `force`.
 */
export async function runCronJob(
  db: Db,
  job: "daily" | "monthly",
  steps: Step[],
  opts: { now?: Date; force?: boolean; onError?: (step: string, err: unknown) => void } = {},
): Promise<CronOutcome> {
  const now = opts.now ?? new Date();
  const runDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const inserted = await db
    .insert(cronRuns)
    .values({ job, runDate, startedAt: now, steps: [] })
    .onConflictDoNothing({ target: [cronRuns.job, cronRuns.runDate] })
    .returning({ id: cronRuns.id });
  let runId: string;
  if (inserted.length) runId = inserted[0].id;
  else {
    const [existing] = await db
      .select()
      .from(cronRuns)
      .where(and(eq(cronRuns.job, job), eq(cronRuns.runDate, runDate)));
    if (existing.finishedAt && !opts.force)
      return { job, runDate: isoDate(runDate), status: "already_ran", steps: existing.steps };
    runId = existing.id;
    await db
      .update(cronRuns)
      .set({ startedAt: now, finishedAt: null, steps: [] })
      .where(eq(cronRuns.id, runId));
  }

  const results: CronStepResult[] = [];
  for (const step of steps) {
    const t0 = Date.now();
    try {
      const count = await step.run();
      results.push({
        step: step.name,
        ok: true,
        count: typeof count === "number" ? count : undefined,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      results.push({
        step: step.name,
        ok: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - t0,
      });
      opts.onError?.(step.name, err);
    }
    // Persist progress after every step so a crash mid-run still leaves a record.
    await db.update(cronRuns).set({ steps: results }).where(eq(cronRuns.id, runId));
  }
  await db
    .update(cronRuns)
    .set({ finishedAt: new Date(), steps: results })
    .where(eq(cronRuns.id, runId));
  return {
    job,
    runDate: isoDate(runDate),
    status: results.every((r) => r.ok) ? "completed" : "completed_with_errors",
    steps: results,
  };
}
