import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db/client";
import { books, loans, members, notifications } from "@/db/schema";
import type { SmsProvider, WhatsAppProvider } from "./providers";
import {
  isDailyReminder,
  isTemplateName,
  renderSms,
  whatsappParams,
  type TemplateName,
  type TemplateVars,
} from "./templates";

export type NotifyDeps = {
  whatsapp: WhatsAppProvider;
  sms: SmsProvider;
  /** Member id -> E.164 phone without plus. Phones live only in Supabase Auth. */
  phoneFor: (memberId: string) => Promise<string | null>;
  appUrl: string;
  now?: () => Date;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export const WHATSAPP_FALLBACK_AFTER_MS = 10 * 60_000;

const startOfDayUtc = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * Requirement 11.2: a daily-reminder template is sent at most once per loan
 * per calendar day. Applies only to templates flagged `dailyReminder`.
 */
export async function alreadySentToday(
  db: DbOrTx,
  memberId: string,
  template: TemplateName,
  loanId: string | null,
  now: Date,
): Promise<boolean> {
  if (!isDailyReminder(template) || !loanId) return false;
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.memberId, memberId),
        eq(notifications.template, template),
        eq(notifications.loanId, loanId),
        gte(notifications.createdAt, startOfDayUtc(now)),
        inArray(notifications.status, ["queued", "sent", "delivered"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Queue a notification. Returns the row id, or null when suppressed by the
 * daily dedupe. Sending happens in `dispatchQueued` so callers inside a
 * transaction never wait on a provider.
 */
export async function enqueue(
  db: DbOrTx,
  input: {
    memberId: string;
    template: TemplateName;
    vars: TemplateVars;
    loanId?: string | null;
    now?: Date;
  },
): Promise<string | null> {
  const now = input.now ?? new Date();
  if (await alreadySentToday(db, input.memberId, input.template, input.loanId ?? null, now))
    return null;
  const [row] = await db
    .insert(notifications)
    .values({
      memberId: input.memberId,
      template: input.template,
      channel: "whatsapp",
      payload: input.vars,
      status: "queued",
      loanId: input.loanId ?? null,
      createdAt: now,
    })
    .returning({ id: notifications.id });
  return row.id;
}

/** Fills in book title, names, and the deep link so templates have what they need. */
async function enrich(
  db: DbOrTx,
  row: { loanId: string | null; payload: TemplateVars; memberId: string },
  appUrl: string,
): Promise<TemplateVars> {
  const vars: TemplateVars = { ...row.payload, link: `${appUrl}/requests` };
  if (!row.loanId) return vars;
  const [l] = await db
    .select({
      title: books.title,
      lenderId: loans.lenderId,
      borrowerId: loans.borrowerId,
      dueAt: loans.dueAt,
    })
    .from(loans)
    .innerJoin(books, eq(books.id, loans.bookId))
    .where(eq(loans.id, row.loanId));
  if (!l) return vars;
  vars.book ??= l.title;
  vars.link = `${appUrl}/loans/${row.loanId}`;
  if (l.dueAt && vars.dueAt === undefined) vars.dueAt = l.dueAt.toISOString();
  const otherId = row.memberId === l.lenderId ? l.borrowerId : l.lenderId;
  const people = await db
    .select({ id: members.id, name: members.displayName, trust: members.trustScore })
    .from(members)
    .where(inArray(members.id, [l.lenderId, l.borrowerId]));
  const other = people.find((p) => p.id === otherId);
  vars.other ??= other?.name ?? "the other member";
  vars.lender ??= people.find((p) => p.id === l.lenderId)?.name ?? "the lender";
  vars.borrower ??= people.find((p) => p.id === l.borrowerId)?.name ?? "the borrower";
  if (vars.trust === undefined) vars.trust = people.find((p) => p.id === l.borrowerId)?.trust ?? "";
  if (vars.onTime === undefined) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(loans)
      .where(
        and(
          eq(loans.borrowerId, l.borrowerId),
          sql`${loans.returnedAt} is not null and ${loans.dueAt} is not null and ${loans.returnedAt} <= ${loans.dueAt}`,
        ),
      );
    vars.onTime = Number(n);
  }
  return vars;
}

/**
 * Sends every `queued` row, oldest first. Called after transactions commit
 * (server actions) and by the cron sweep. Marks rows sent/failed; on a
 * WhatsApp failure that is not retryable, falls straight through to SMS.
 */
export async function dispatchQueued(
  db: Db,
  deps: NotifyDeps,
  limit = 100,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? (() => {});
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.status, "queued"))
    .orderBy(asc(notifications.createdAt))
    .limit(limit);
  const out = { sent: 0, failed: 0, skipped: 0 };

  for (const row of rows) {
    // Claim the row so a concurrent dispatcher skips it.
    const claimed = await db
      .update(notifications)
      .set({ status: "sent", sentAt: now })
      .where(and(eq(notifications.id, row.id), eq(notifications.status, "queued")))
      .returning({ id: notifications.id });
    if (!claimed.length) continue;

    if (!isTemplateName(row.template)) {
      await db
        .update(notifications)
        .set({ status: "failed", failureReason: `unknown template ${row.template}` })
        .where(eq(notifications.id, row.id));
      out.failed++;
      continue;
    }
    const phone = await deps.phoneFor(row.memberId);
    if (!phone) {
      await db
        .update(notifications)
        .set({ status: "failed", failureReason: "no phone" })
        .where(eq(notifications.id, row.id));
      out.skipped++;
      continue;
    }
    const vars = await enrich(
      db,
      { loanId: row.loanId, payload: row.payload as TemplateVars, memberId: row.memberId },
      deps.appUrl,
    );

    if (row.channel === "sms") {
      const res = await deps.sms.sendText({ phone, text: renderSms(row.template, vars) });
      await db
        .update(notifications)
        .set(
          res.ok
            ? { providerRef: res.providerRef, payload: vars }
            : { status: "failed", failureReason: res.error },
        )
        .where(eq(notifications.id, row.id));
      if (res.ok) out.sent++;
      else out.failed++;
      continue;
    }

    const res = await deps.whatsapp.sendTemplate({
      phone,
      template: row.template,
      bodyParams: whatsappParams(row.template, vars),
    });
    if (res.ok) {
      await db
        .update(notifications)
        .set({ providerRef: res.providerRef, payload: vars })
        .where(eq(notifications.id, row.id));
      out.sent++;
    } else {
      await db
        .update(notifications)
        .set({ status: "failed", failureReason: res.error, payload: vars })
        .where(eq(notifications.id, row.id));
      log("whatsapp send failed; falling back to sms", { id: row.id, error: res.error });
      await enqueueSmsFallback(db, row.id, now);
      out.failed++;
    }
  }
  return out;
}

async function enqueueSmsFallback(db: DbOrTx, whatsappRowId: string, now: Date): Promise<boolean> {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, whatsappRowId));
  if (!row) return false;
  // One fallback per WhatsApp row.
  const [existing] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.channel, "sms"),
        sql`${notifications.payload} ->> '_fallback_of' = ${whatsappRowId}`,
      ),
    )
    .limit(1);
  if (existing) return false;
  await db.insert(notifications).values({
    memberId: row.memberId,
    template: row.template,
    channel: "sms",
    payload: { ...(row.payload as TemplateVars), _fallback_of: whatsappRowId },
    status: "queued",
    loanId: row.loanId,
    createdAt: now,
  });
  return true;
}

/**
 * Requirement 11.1: WhatsApp rows still not delivered 10 minutes after
 * sending get one SMS. Run from the cron and after dispatch.
 */
export async function sweepUndelivered(db: Db, deps: NotifyDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - WHATSAPP_FALLBACK_AFTER_MS);
  const stale = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.channel, "whatsapp"),
        eq(notifications.status, "sent"),
        isNull(notifications.deliveredAt),
        lt(notifications.sentAt, cutoff),
      ),
    )
    .limit(200);
  let queued = 0;
  for (const s of stale) {
    if (await enqueueSmsFallback(db, s.id, now)) queued++;
    // Mark so we don't sweep it again; the delivery webhook can still flip it to delivered.
    await db
      .update(notifications)
      .set({ failureReason: "undelivered after 10 min; sms fallback queued" })
      .where(eq(notifications.id, s.id));
  }
  if (queued) await dispatchQueued(db, deps);
  return queued;
}

/** Interakt delivery webhook: flips sent -> delivered/failed by provider ref. */
export async function recordDeliveryStatus(
  db: DbOrTx,
  input: {
    providerRef: string;
    status: "delivered" | "failed" | "read";
    reason?: string;
    at?: Date;
  },
): Promise<boolean> {
  const status = input.status === "failed" ? "failed" : "delivered";
  const rows = await db
    .update(notifications)
    .set(
      status === "delivered"
        ? { status, deliveredAt: input.at ?? new Date() }
        : { status, failureReason: input.reason ?? "provider reported failure" },
    )
    .where(
      and(
        eq(notifications.providerRef, input.providerRef),
        inArray(notifications.status, ["sent", "delivered"]),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length > 0;
}
