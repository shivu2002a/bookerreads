"use client";

import {
  confirmHandoffWithCode,
  confirmHandoffWithPhoto,
  confirmReturnWithCode,
  confirmReturnWithPhoto,
} from "@/app/(member)/loans/actions";
import { isNetworkError, outbox, type OutboxItem } from "./outbox";

/** Errors that mean the server already has this confirmation; drop the item. */
const SETTLED_CODES = new Set([
  "already_confirmed",
  "invalid_transition",
  "already_confirmed_by_both",
]);
const MAX_ATTEMPTS = 20;

async function send(item: OutboxItem) {
  switch (item.action) {
    case "confirm_handoff_photo":
      return confirmHandoffWithPhoto(item.loanId, item.args.photoPath!);
    case "confirm_handoff_code":
      return confirmHandoffWithCode(item.loanId, item.args.code!);
    case "confirm_return_photo":
      return confirmReturnWithPhoto(item.loanId, item.args.photoPath!, item.args.condition);
    case "confirm_return_code":
      return confirmReturnWithCode(item.loanId, item.args.code!, item.args.condition);
  }
}

let replaying = false;

/** Sends every queued confirmation, oldest first. Safe to call often. */
export async function replayOutbox(): Promise<{ sent: number; kept: number; failed: string[] }> {
  if (replaying || !outbox.supported()) return { sent: 0, kept: 0, failed: [] };
  replaying = true;
  const result = { sent: 0, kept: 0, failed: [] as string[] };
  try {
    for (const item of await outbox.list()) {
      try {
        const res = await send(item);
        if (res.ok || SETTLED_CODES.has(res.code)) {
          await outbox.remove(item.id);
          result.sent++;
        } else {
          // A real refusal (wrong code, not a party...): stop retrying and surface it.
          await outbox.remove(item.id);
          result.failed.push(res.message);
        }
      } catch (err) {
        if (isNetworkError(err) && item.attempts < MAX_ATTEMPTS) {
          await outbox.bump(item);
          result.kept++;
        } else {
          await outbox.remove(item.id);
          result.failed.push("A queued confirmation could not be sent.");
        }
      }
    }
  } finally {
    replaying = false;
  }
  return result;
}

let installed = false;

/** Replays on `online` and once at startup. Idempotent. */
export function installOutboxReplay(
  onResult?: (r: Awaited<ReturnType<typeof replayOutbox>>) => void,
): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const run = () => void replayOutbox().then((r) => onResult?.(r));
  window.addEventListener("online", run);
  if (navigator.onLine) setTimeout(run, 1500);
}
