"use server";

import { z } from "zod";
import { getDb } from "@/db/client";
import { track } from "@/lib/analytics/server";
import { getCurrentMember } from "@/lib/auth/current-member";
import { searchBooks, type BookSummary } from "@/lib/search/queries";

const schema = z.object({
  query: z.string().trim().min(2).max(120),
  clusterId: z.uuid().nullable(),
});

/**
 * Search runs against the viewer's home cluster when signed in, otherwise the
 * cluster passed from the page (chosen via the cluster picker).
 */
export async function searchAction(input: {
  query: string;
  clusterId: string | null;
}): Promise<BookSummary[]> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return [];
  const member = await getCurrentMember();
  const clusterId = member?.clusterId ?? parsed.data.clusterId;
  const results = await searchBooks(getDb(), { query: parsed.data.query, clusterId });
  if (member) track(member.id, "search_performed", { results: results.length });
  return results;
}
