"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminActions, disputes } from "@/db/schema";
import { err, fieldErrors, ok, type ActionResult } from "@/lib/actions/result";
import { AdminReasonRequired } from "@/lib/admin/act";
import { bookEditSchema, editBook, mergeBooks } from "@/lib/admin/catalogue";
import {
  createDropPoint,
  dropPointSchema,
  rotateDropPointSecret,
  updateDropPoint,
} from "@/lib/admin/drop-points";
import { overrideLoanState } from "@/lib/admin/loans";
import {
  addMemberNote,
  adjustDeposit,
  openCluster,
  reinstateMember,
  setUpiVerified,
  suspendMember,
} from "@/lib/admin/members";
import { requireAdmin } from "@/lib/auth/current-member";
import { loadConfig, setConfigValue } from "@/lib/config/load";
import { configSchemas, type ConfigKey } from "@/lib/config/schema";
import { applyLoanEvent } from "@/lib/loans/persist";
import { LOAN_STATES } from "@/lib/loans/types";
import { flushNotifications } from "@/lib/notify";
import { generatePayoutBatch, markBatchExported, markPayoutResult } from "@/lib/payouts/batch";
import { runPool } from "@/lib/pool/run";

const uuid = z.uuid();
const reason = z.string().trim().min(3, "Give a reason (at least 3 characters).").max(1000);

/** Every admin action funnels through here so AdminReasonRequired and unexpected errors map the same way. */
async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof AdminReasonRequired) return err(e.code, e.message);
    console.error("admin action failed", e);
    return err("failed", (e as Error).message || "Something went wrong.");
  }
}

// ---------------------------------------------------------------------------
// disputes
// ---------------------------------------------------------------------------

const resolveSchema = z.object({
  disputeId: uuid,
  resolution: z.enum(["dismissed", "partial_charge", "full_charge"]),
  chargePaise: z.coerce.number().int().positive().optional(),
  note: reason,
});

export async function resolveDisputeAction(
  input: z.input<typeof resolveSchema>,
): Promise<ActionResult<{ loanId: string }>> {
  const admin = await requireAdmin();
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) return err("invalid", parsed.error.issues[0].message);
  const db = getDb();
  const [dispute] = await db
    .select({ loanId: disputes.loanId, state: disputes.state })
    .from(disputes)
    .where(eq(disputes.id, parsed.data.disputeId));
  if (!dispute) return err("not_found", "Dispute not found.");
  if (dispute.state !== "open")
    return err("already_resolved", "This dispute has already been resolved.");
  const config = await loadConfig(db);
  const res = await applyLoanEvent(
    db,
    dispute.loanId,
    {
      type: "resolve",
      resolution: parsed.data.resolution,
      chargePaise: parsed.data.chargePaise,
      note: parsed.data.note,
    },
    { kind: "member", memberId: admin.id, isAdmin: true },
    config,
  );
  if (!res.ok) return err(res.error.code, res.error.message);
  await db.insert(adminActions).values({
    adminId: admin.id,
    targetType: "dispute",
    targetId: parsed.data.disputeId,
    action: "dispute.resolve",
    reason: parsed.data.note,
    payload: {
      resolution: parsed.data.resolution,
      chargePaise: parsed.data.chargePaise ?? null,
      loanId: dispute.loanId,
    },
  });
  await flushNotifications();
  revalidatePath("/admin/disputes");
  revalidatePath(`/loans/${dispute.loanId}`);
  return ok({ loanId: dispute.loanId });
}

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------

export async function memberAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const memberId = uuid.safeParse(formData.get("memberId"));
  const r = reason.safeParse(formData.get("reason"));
  if (!memberId.success) return err("invalid", "Bad member id.");
  if (!r.success) return err("reason_required", r.error.issues[0].message);
  const db = getDb();
  const kind = String(formData.get("kind"));
  const res = await guard(async () => {
    switch (kind) {
      case "suspend": {
        const days = z.coerce
          .number()
          .int()
          .min(1)
          .max(365)
          .parse(formData.get("days") ?? 30);
        await suspendMember(db, {
          adminId: admin.id,
          memberId: memberId.data,
          untilDays: days,
          reason: r.data,
        });
        break;
      }
      case "reinstate":
        await reinstateMember(db, {
          adminId: admin.id,
          memberId: memberId.data,
          reason: r.data,
          config: await loadConfig(db),
        });
        break;
      case "adjust_deposit": {
        const amount = z.coerce
          .number()
          .int()
          .refine((n) => n !== 0, "Amount cannot be zero.")
          .parse(formData.get("amountPaise"));
        await adjustDeposit(
          db,
          { adminId: admin.id, memberId: memberId.data, amountPaise: amount, reason: r.data },
          await loadConfig(db),
        );
        break;
      }
      case "note":
        await addMemberNote(db, { adminId: admin.id, memberId: memberId.data, note: r.data });
        break;
      case "upi_verify":
        await setUpiVerified(db, {
          adminId: admin.id,
          memberId: memberId.data,
          verified: true,
          reason: r.data,
        });
        break;
      case "upi_unverify":
        await setUpiVerified(db, {
          adminId: admin.id,
          memberId: memberId.data,
          verified: false,
          reason: r.data,
        });
        break;
      default:
        throw new Error("Unknown action.");
    }
  });
  if (!res.ok) return res;
  revalidatePath(`/admin/members/${memberId.data}`);
  return ok();
}

export async function openClusterAction(
  clusterId: string,
  why: string,
): Promise<ActionResult<{ notified: number }>> {
  const admin = await requireAdmin();
  if (!uuid.safeParse(clusterId).success) return err("invalid", "Bad cluster id.");
  const res = await guard(() =>
    openCluster(getDb(), { adminId: admin.id, clusterId, reason: why }),
  );
  if (!res.ok) return res;
  await flushNotifications();
  revalidatePath("/admin/health");
  return ok({ notified: res.data });
}

// ---------------------------------------------------------------------------
// loans
// ---------------------------------------------------------------------------

export async function overrideLoanAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = z
    .object({ loanId: uuid, toState: z.enum(LOAN_STATES), reason })
    .safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return err("invalid", parsed.error.issues[0].message);
  const res = await overrideLoanState(getDb(), { adminId: admin.id, ...parsed.data });
  if (!res.ok) return err("override_failed", res.error);
  revalidatePath(`/admin/loans/${parsed.data.loanId}`);
  revalidatePath(`/loans/${parsed.data.loanId}`);
  return ok();
}

// ---------------------------------------------------------------------------
// drop points
// ---------------------------------------------------------------------------

function parseHours(formData: FormData) {
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  return Object.fromEntries(
    days.map((d) => {
      const open = String(formData.get(`${d}_open`) ?? "").trim();
      const close = String(formData.get(`${d}_close`) ?? "").trim();
      return [d, open && close ? { open, close } : null];
    }),
  );
}

export async function saveDropPointAction(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  const r = reason.safeParse(formData.get("reason"));
  if (!r.success) return err("reason_required", r.error.issues[0].message);
  const parsed = dropPointSchema.safeParse({
    clusterId: formData.get("clusterId"),
    name: formData.get("name"),
    address: formData.get("address"),
    contact: formData.get("contact"),
    capacity: formData.get("capacity"),
    active: formData.get("active") === "on",
    hours: parseHours(formData),
  });
  if (!parsed.success)
    return err("invalid", "Check the highlighted fields.", fieldErrors(parsed.error.issues));
  const existing = String(formData.get("id") ?? "");
  const db = getDb();
  const res = await guard(async () => {
    if (existing) {
      await updateDropPoint(db, existing, { ...parsed.data, adminId: admin.id, reason: r.data });
      return existing;
    }
    return createDropPoint(db, { ...parsed.data, adminId: admin.id, reason: r.data });
  });
  if (!res.ok) return res;
  revalidatePath("/admin/drop-points");
  return ok({ id: res.data });
}

export async function rotateSecretAction(id: string, why: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!uuid.safeParse(id).success) return err("invalid", "Bad id.");
  const res = await guard(() =>
    rotateDropPointSecret(getDb(), { adminId: admin.id, id, reason: why }),
  );
  if (!res.ok) return res;
  revalidatePath(`/admin/drop-points/${id}`);
  return ok();
}

// ---------------------------------------------------------------------------
// catalogue
// ---------------------------------------------------------------------------

export async function editBookAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const bookId = uuid.safeParse(formData.get("bookId"));
  const r = reason.safeParse(formData.get("reason"));
  if (!bookId.success) return err("invalid", "Bad book id.");
  if (!r.success) return err("reason_required", r.error.issues[0].message);
  const data = bookEditSchema.safeParse({
    title: formData.get("title"),
    authors: formData.get("authors"),
    isbn13: formData.get("isbn13"),
    publisher: formData.get("publisher"),
    publishedYear: formData.get("publishedYear") || null,
    language: formData.get("language") || "en",
    listPricePaise: formData.get("listPricePaise") || null,
  });
  if (!data.success)
    return err("invalid", "Check the highlighted fields.", fieldErrors(data.error.issues));
  const res = await editBook(getDb(), {
    adminId: admin.id,
    bookId: bookId.data,
    reason: r.data,
    approve: formData.get("approve") === "on",
    data: data.data,
  });
  if (!res.ok) return err("edit_failed", res.error);
  revalidatePath("/admin/catalogue");
  revalidatePath(`/admin/catalogue/${bookId.data}`);
  return ok();
}

export async function mergeBooksAction(
  duplicateId: string,
  survivorId: string,
  why: string,
): Promise<ActionResult<{ movedCopies: number }>> {
  const admin = await requireAdmin();
  if (!uuid.safeParse(duplicateId).success || !uuid.safeParse(survivorId).success)
    return err("invalid", "Bad book id.");
  const res = await mergeBooks(getDb(), {
    adminId: admin.id,
    duplicateId,
    survivorId,
    reason: why,
  });
  if (!res.ok) return err("merge_failed", res.error);
  revalidatePath("/admin/catalogue");
  return ok({ movedCopies: res.movedCopies });
}

// ---------------------------------------------------------------------------
// pool and payouts
// ---------------------------------------------------------------------------

export async function runPoolAction(monthIso: string): Promise<ActionResult<{ status: string }>> {
  await requireAdmin();
  const m = new Date(monthIso);
  if (Number.isNaN(m.getTime())) return err("invalid", "Bad month.");
  const db = getDb();
  const config = await loadConfig(db);
  const res = await guard(() => runPool(db, m, config));
  if (!res.ok) return res;
  await flushNotifications();
  revalidatePath("/admin/pool");
  return ok({ status: res.data.status });
}

export async function generateBatchAction(
  poolRunId: string,
): Promise<ActionResult<{ created: number }>> {
  await requireAdmin();
  if (!uuid.safeParse(poolRunId).success) return err("invalid", "Bad id.");
  const db = getDb();
  const config = await loadConfig(db);
  const res = await guard(() => generatePayoutBatch(db, poolRunId, config));
  if (!res.ok) return res;
  revalidatePath("/admin/payouts");
  return ok({ created: res.data.created });
}

export async function markExportedAction(
  batchId: string,
): Promise<ActionResult<{ count: number }>> {
  await requireAdmin();
  const count = await markBatchExported(getDb(), batchId);
  revalidatePath("/admin/payouts");
  return ok({ count });
}

export async function payoutResultAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = z
    .object({
      payoutId: uuid,
      result: z.enum(["paid", "failed"]),
      razorpayPayoutId: z.string().trim().optional(),
      failureReason: z.string().trim().optional(),
      reason,
    })
    .safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return err("invalid", parsed.error.issues[0].message);
  const res = await markPayoutResult(getDb(), { ...parsed.data, adminId: admin.id });
  if (!res.ok)
    return err(res.error, res.error === "not_found" ? "Payout not found." : "Already settled.");
  await flushNotifications();
  revalidatePath("/admin/payouts");
  return ok();
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export async function setConfigAction(key: string, json: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!(key in configSchemas)) return err("invalid", "Unknown key.");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return err("invalid", "Value must be valid JSON.");
  }
  try {
    await setConfigValue(getDb(), key as ConfigKey, value, admin.id);
  } catch (e) {
    return err("invalid", (e as Error).message);
  }
  await getDb()
    .insert(adminActions)
    .values({
      adminId: admin.id,
      targetType: "config",
      targetId: admin.id,
      action: "config.set",
      reason: `set ${key}`,
      payload: { key, value },
    });
  revalidatePath("/admin");
  return ok();
}
