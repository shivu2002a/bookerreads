import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  copies,
  disputes,
  dropPoints,
  events,
  loanPayments,
  loanPhotos,
  members,
  notifications,
} from "@/db/schema";
import type { AppConfig } from "@/lib/config/schema";
import { postEntry } from "@/lib/ledger/post";
import { recordTrustEvent } from "@/lib/trust/record";
import { enqueue } from "@/lib/notify/send";
import { isTemplateName } from "@/lib/notify/templates";
import type { Effect } from "./types";

/**
 * Applies machine effects inside the caller's transaction, in order.
 * Notifications are only queued here (Phase 6 sends them).
 */
export async function applyEffects(
  tx: Tx,
  effects: Effect[],
  config: AppConfig,
  now: Date,
): Promise<void> {
  for (const e of effects) {
    switch (e.kind) {
      case "set_copy_availability":
        await tx
          .update(copies)
          .set({ availability: e.availability, lastActivityAt: now })
          .where(eq(copies.id, e.copyId));
        break;
      case "increment_decline_count":
        await tx
          .update(copies)
          .set({ declineCount: sql`${copies.declineCount} + ${e.by}` })
          .where(eq(copies.id, e.copyId));
        break;
      case "reset_decline_count":
        await tx.update(copies).set({ declineCount: 0 }).where(eq(copies.id, e.copyId));
        break;
      case "unlist_copy": {
        await tx
          .update(copies)
          .set({ availability: "unlisted", lastActivityAt: now })
          .where(eq(copies.id, e.copyId));
        await tx.insert(events).values({
          aggregate: "copy",
          aggregateId: e.copyId,
          type: "copy.auto_unlisted",
          payload: { reason: e.reason },
        });
        if (e.reason !== "no_longer_have") {
          const [c] = await tx
            .select({ ownerId: copies.ownerId })
            .from(copies)
            .where(eq(copies.id, e.copyId));
          if (c) {
            await tx.insert(notifications).values({
              memberId: c.ownerId,
              template: "copy_auto_unlisted",
              channel: "whatsapp",
              payload: { copyId: e.copyId, reason: e.reason },
              status: "queued",
            });
          }
        }
        break;
      }
      case "verify_copy":
        await tx
          .update(copies)
          .set({ verificationStatus: "verified" })
          .where(eq(copies.id, e.copyId));
        break;
      case "drop_point_occupancy":
        await tx
          .update(dropPoints)
          .set({ occupancy: sql`greatest(0, ${dropPoints.occupancy} + ${e.delta})` })
          .where(eq(dropPoints.id, e.dropPointId));
        break;
      case "loan_photo":
        await tx.insert(loanPhotos).values({
          loanId: e.loanId,
          takenBy: e.takenBy,
          phase: e.phase,
          storagePath: e.storagePath,
          condition: e.condition ?? null,
          createdAt: now,
        });
        break;
      case "trust_event":
        await recordTrustEvent(
          tx,
          { memberId: e.memberId, kind: e.trustKind, loanId: e.loanId, now },
          config,
        );
        break;
      case "suspend_member":
        await tx
          .update(members)
          .set({ state: "suspended", suspendedUntil: e.until })
          .where(eq(members.id, e.memberId));
        await tx.insert(events).values({
          aggregate: "member",
          aggregateId: e.memberId,
          type: "member.suspended",
          payload: { until: e.until.toISOString() },
        });
        break;
      case "set_first_borrow_completed":
        await tx
          .update(members)
          .set({ firstBorrowCompletedAt: e.at })
          .where(sql`${members.id} = ${e.memberId} and ${members.firstBorrowCompletedAt} is null`);
        break;
      case "ledger": {
        const res = await postEntry(tx, {
          memberId: e.memberId,
          account: e.account,
          kind: e.ledgerKind,
          amountPaise: e.amountPaise,
          loanId: e.loanId,
          note: e.note,
          createdAt: now,
        });
        if (e.ledgerKind === "deposit_charge") {
          // Deposit below the required level blocks new requests until topped up (Requirement 7.5).
          await tx
            .update(members)
            .set({ needsTopup: true })
            .where(
              sql`${members.id} = ${e.memberId} and ${members.depositBalancePaise} < ${config.deposit_paise}`,
            );
          if (res.shortfallPaise > 0) {
            // The lender is still made whole; the platform absorbs the gap (design.md Lost book).
            await tx.insert(events).values({
              aggregate: "loan",
              aggregateId: e.loanId,
              type: "ledger.deposit_shortfall",
              payload: { memberId: e.memberId, shortfallPaise: res.shortfallPaise },
            });
          }
        }
        break;
      }
      case "mark_payment_captured":
        // The order row was created when the borrower opened checkout; the webhook or the
        // verified checkout callback closes it. Idempotent on the unique payment id.
        await tx
          .update(loanPayments)
          .set({
            status: "captured",
            razorpayPaymentId: e.razorpayPaymentId,
            paidAt: now,
            updatedAt: now,
          })
          .where(
            sql`${loanPayments.loanId} = ${e.loanId} and ${loanPayments.status} = 'created' and ${loanPayments.amountPaise} = ${e.amountPaise}`,
          );
        break;
      case "refund_payment":
        // Refunds call an external API, so the cron does the call; here we only flag the row.
        await tx
          .update(loanPayments)
          .set({ status: "refund_pending", updatedAt: now })
          .where(sql`${loanPayments.loanId} = ${e.loanId} and ${loanPayments.status} = 'captured'`);
        await tx.insert(events).values({
          aggregate: "loan",
          aggregateId: e.loanId,
          type: "payment.refund_requested",
          payload: { amountPaise: e.amountPaise },
        });
        break;
      case "create_dispute":
        await tx.insert(disputes).values({
          loanId: e.loanId,
          openedBy: e.openedBy,
          reason: e.reason,
          state: "open",
          createdAt: now,
        });
        break;
      case "resolve_dispute":
        await tx
          .update(disputes)
          .set({
            state: "resolved",
            resolution: e.resolution,
            chargePaise: e.chargePaise,
            resolvedBy: e.resolvedBy,
            resolvedAt: now,
            resolutionNote: e.note,
          })
          .where(eq(disputes.loanId, e.loanId));
        break;
      case "notify":
        if (isTemplateName(e.template)) {
          await enqueue(tx, {
            memberId: e.memberId,
            template: e.template,
            vars: e.vars,
            loanId: e.loanId,
            now,
          });
        }
        break;
      case "notify_admins": {
        const admins = await tx
          .select({ id: members.id })
          .from(members)
          .where(sql`${members.isAdmin} and ${members.deletedAt} is null`);
        if (admins.length) {
          await tx.insert(notifications).values(
            admins.map((a) => ({
              memberId: a.id,
              template: e.template,
              channel: "whatsapp" as const,
              payload: e.vars,
              status: "queued" as const,
              loanId: e.loanId,
              createdAt: now,
            })),
          );
        }
        break;
      }
    }
  }
}
