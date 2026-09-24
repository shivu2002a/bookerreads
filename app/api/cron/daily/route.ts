import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { loadConfig } from "@/lib/config/load";
import { dailySteps } from "@/lib/cron/daily";
import { runCronJob } from "@/lib/cron/runner";
import { getServerEnv } from "@/lib/env";
import { flushNotifications, getNotifyDeps } from "@/lib/notify";
import { assertCronSecret } from "@/lib/security/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel Cron, 02:00 IST daily. `?force=1` re-runs today's job (manual recovery). */
export async function GET(request: Request) {
  const env = getServerEnv();
  const denied = assertCronSecret(request, env.CRON_SECRET);
  if (denied) return denied;

  const db = getDb();
  const config = await loadConfig(db);
  const now = new Date();
  const force = new URL(request.url).searchParams.get("force") === "1";

  const outcome = await runCronJob(db, "daily", dailySteps(db, config, getNotifyDeps(), now), {
    now,
    force,
    onError: (step, err) => {
      console.error(`cron daily step ${step} failed`, err);
      Sentry.captureException(err, { tags: { cron: "daily", step } });
    },
  });
  await flushNotifications();
  return NextResponse.json(outcome, {
    status: outcome.status === "completed_with_errors" ? 207 : 200,
  });
}
