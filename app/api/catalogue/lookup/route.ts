import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getCurrentMember } from "@/lib/auth/current-member";
import { defaultProviders, lookupByIsbn } from "@/lib/catalogue/lookup";
import { getServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/catalogue/lookup?isbn=978...
 * Called by the scanner island after a barcode hit (Requirement 2.1).
 * Members only: this endpoint can trigger paid external API calls.
 */
export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "not_signed_in" }, { status: 401 });

  const isbn = request.nextUrl.searchParams.get("isbn") ?? "";
  if (!isbn) return NextResponse.json({ error: "missing_isbn" }, { status: 400 });

  const env = getServerEnv();
  const result = await lookupByIsbn(getDb(), isbn, {
    providers: defaultProviders({ googleApiKey: env.GOOGLE_BOOKS_API_KEY || undefined }),
  });

  switch (result.status) {
    case "invalid_isbn":
      return NextResponse.json({ error: "invalid_isbn" }, { status: 400 });
    case "not_found":
      return NextResponse.json({ error: "not_found", isbn13: result.isbn13 }, { status: 404 });
    case "found": {
      const b = result.book;
      return NextResponse.json(
        {
          book: {
            id: b.id,
            isbn13: b.isbn13,
            title: b.title,
            authors: b.authors,
            publisher: b.publisher,
            publishedYear: b.publishedYear,
            pageCount: b.pageCount,
            coverUrl: b.coverUrl,
            listPricePaise: b.listPricePaise,
            needsReview: b.needsReview,
          },
          from: result.from,
        },
        { headers: { "cache-control": "private, max-age=3600" } },
      );
    }
  }
}
