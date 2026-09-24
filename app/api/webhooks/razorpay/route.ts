import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { loadConfig } from "@/lib/config/load";
import { getServerEnv } from "@/lib/env";
import {
  processRazorpayWebhook,
  webhookEventId,
  type RazorpayWebhook,
} from "@/lib/payments/webhooks";
import { verifyRazorpayWebhookSignature } from "@/lib/security/webhook-signature";
import { flushNotifications } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Razorpay webhooks (design.md Error Handling): verify the HMAC over the raw
 * body, dedupe on the event id, 200 for processed/duplicate/ignored, 500 only
 * for a transient failure so Razorpay retries.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const env = getServerEnv();
  if (
    !verifyRazorpayWebhookSignature(
      rawBody,
      request.headers.get("x-razorpay-signature"),
      env.RAZORPAY_WEBHOOK_SECRET,
    )
  ) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let body: RazorpayWebhook;
  try {
    body = JSON.parse(rawBody) as RazorpayWebhook;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body?.event || typeof body.event !== "string")
    return NextResponse.json({ error: "missing_event" }, { status: 400 });

  const eventId = webhookEventId(request.headers.get("x-razorpay-event-id"), rawBody);
  const db = getDb();
  try {
    const config = await loadConfig(db);
    const outcome = await processRazorpayWebhook(db, { eventId, body, rawBody }, config);
    if (outcome.status === "processed") await flushNotifications();
    return NextResponse.json(outcome, { status: 200 });
  } catch (err) {
    console.error("razorpay webhook failed", {
      event: body.event,
      eventId,
      message: (err as Error).message,
    });
    return NextResponse.json({ error: "transient" }, { status: 500 });
  }
}
