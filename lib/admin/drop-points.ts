import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@/db/client";
import { books, clusters, dropPoints, loans, type DropPointHours } from "@/db/schema";
import { adminAction } from "./act";

const time = z.string().regex(/^\d{2}:\d{2}$/);
const day = z.object({ open: time, close: time }).nullable();
export const dropPointSchema = z.object({
  clusterId: z.uuid(),
  name: z.string().trim().min(2).max(80),
  address: z.string().trim().min(5).max(200),
  contact: z.string().trim().min(3).max(120),
  capacity: z.coerce.number().int().min(1).max(500),
  hours: z.object({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day }),
  active: z.coerce.boolean().default(true),
});
export type DropPointInput = z.infer<typeof dropPointSchema>;

export const newQrSecret = () => randomBytes(16).toString("hex");

export async function listDropPoints(db: DbOrTx) {
  return db
    .select({
      dp: dropPoints,
      cluster: clusters.name,
      onShelf: sql<number>`(select count(*) from loans l where l.drop_point_id = ${dropPoints.id} and ((l.state = 'accepted' and l.out_lender_confirmed_at is not null and l.out_borrower_confirmed_at is null) or (l.state in ('on_loan','overdue') and l.return_borrower_confirmed_at is not null and l.return_lender_confirmed_at is null)))`,
    })
    .from(dropPoints)
    .innerJoin(clusters, eq(clusters.id, dropPoints.clusterId))
    .orderBy(clusters.name, dropPoints.name);
}

export async function getDropPoint(db: DbOrTx, id: string) {
  const [row] = await db.select().from(dropPoints).where(eq(dropPoints.id, id));
  if (!row) return null;
  const shelf = await db
    .select({
      loanId: loans.id,
      title: books.title,
      since: sql<Date>`coalesce(${loans.returnBorrowerConfirmedAt}, ${loans.outLenderConfirmedAt})`,
    })
    .from(loans)
    .innerJoin(books, eq(books.id, loans.bookId))
    .where(
      and(
        eq(loans.dropPointId, id),
        sql`(${loans.state} = 'accepted' and ${loans.outLenderConfirmedAt} is not null and ${loans.outBorrowerConfirmedAt} is null) or (${loans.state} in ('on_loan','overdue') and ${loans.returnBorrowerConfirmedAt} is not null and ${loans.returnLenderConfirmedAt} is null)`,
      ),
    );
  return { ...row, shelf };
}

export async function createDropPoint(
  db: Db,
  input: DropPointInput & { adminId: string; reason: string },
) {
  const id = crypto.randomUUID();
  await adminAction(
    db,
    {
      adminId: input.adminId,
      target: { type: "drop_point", id },
      action: "drop_point.create",
      reason: input.reason,
    },
    async (tx) => {
      await tx.insert(dropPoints).values({
        id,
        clusterId: input.clusterId,
        name: input.name,
        address: input.address,
        contact: input.contact,
        capacity: input.capacity,
        hours: input.hours as DropPointHours,
        active: input.active,
        qrSecret: newQrSecret(),
      });
    },
  );
  return id;
}

export async function updateDropPoint(
  db: Db,
  id: string,
  input: DropPointInput & { adminId: string; reason: string },
) {
  await adminAction(
    db,
    {
      adminId: input.adminId,
      target: { type: "drop_point", id },
      action: "drop_point.update",
      reason: input.reason,
    },
    async (tx) => {
      await tx
        .update(dropPoints)
        .set({
          clusterId: input.clusterId,
          name: input.name,
          address: input.address,
          contact: input.contact,
          capacity: input.capacity,
          hours: input.hours as DropPointHours,
          active: input.active,
        })
        .where(eq(dropPoints.id, id));
    },
  );
}

/** Invalidates printed posters; reprint after rotating. */
export async function rotateDropPointSecret(
  db: Db,
  input: { adminId: string; id: string; reason: string },
) {
  await adminAction(
    db,
    {
      adminId: input.adminId,
      target: { type: "drop_point", id: input.id },
      action: "drop_point.rotate_secret",
      reason: input.reason,
    },
    async (tx) => {
      await tx
        .update(dropPoints)
        .set({ qrSecret: newQrSecret() })
        .where(eq(dropPoints.id, input.id));
    },
  );
}
