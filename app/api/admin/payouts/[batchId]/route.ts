import { getDb } from "@/db/client";
import { getCurrentMember } from "@/lib/auth/current-member";
import { listBatch, payoutBatchCsv } from "@/lib/payouts/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RazorpayX bulk-payout CSV for one batch. Admin only. */
export async function GET(_req: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const member = await getCurrentMember();
  if (!member?.isAdmin) return new Response("Not found", { status: 404 });
  const { batchId } = await params;
  const id = batchId.replace(/\.csv$/, "");
  const rows = await listBatch(getDb(), id);
  return new Response(payoutBatchCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${id}.csv"`,
      "cache-control": "no-store",
    },
  });
}
