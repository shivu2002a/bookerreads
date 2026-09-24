import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { webhookEvents } from "@/db/schema";
import { getServerEnv } from "@/lib/env";
import { recordDeliveryStatus } from "@/lib/notify";
import { verifyInteraktWebhookSignature } from "@/lib/security/webhook-signature";
import { webhookEventId } from "@/lib/payments/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Interakt message-status callback shape (the fields we read). */
type InteraktStatus = {
  type?: string;
  data?: {
    message?: {
      id?: string;
      message_status?: string;
      channel_failure_reason?: string;
      received_at_utc?: string;
    };
  };
};

const STATUS_MAP: Record<string, "delivered" | "failed" | "read"> = {
  Delivered: "delivered",
  delivered: "delivered",
  Read: "read",
  read: "read",
  Failed: "failed",
  failed: "failed",
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  const env = getServerEnv();
  if (
    !verifyInteraktWebhookSignature(
      rawBody,
      request.headers.get("x-interakt-signature"),
      env.INTERAKT_WEBHOOK_SECRET,
    )
  ) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  let body: InteraktStatus;
  try {
    body = JSON.parse(rawBody) as InteraktStatus;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const db = getDb();
  const eventId = webhookEventId(request.headers.get("x-interakt-event-id"), rawBody);
  const inserted = await db
    .insert(webhookEvents)
    .values({
      provider: "interakt",
      providerEventId: eventId,
      eventType: body.type ?? "unknown",
      payload: body as Record<string, unknown>,
      processedAt: new Date(),
    })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
    .returning({ id: webhookEvents.id });
  if (!inserted.length) return NextResponse.json({ status: "duplicate" });

  const msg = body.data?.message;
  const status = msg?.message_status ? STATUS_MAP[msg.message_status] : undefined;
  if (!msg?.id || !status) return NextResponse.json({ status: "ignored" });

  const matched = await recordDeliveryStatus(db, {
    providerRef: msg.id,
    status,
    reason: msg.channel_failure_reason,
    at: msg.received_at_utc ? new Date(msg.received_at_utc) : undefined,
  });
  return NextResponse.json({ status: matched ? "processed" : "unmatched" });
}
