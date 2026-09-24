import { getJson, TokenBucket, type GetJsonOptions } from "../http";
import { toIsbn13 } from "../isbn";
import type { CatalogueBook, Fetcher } from "../types";

export type GoogleVolumesResponse = {
  totalItems?: number;
  items?: Array<{
    id: string;
    volumeInfo?: {
      title?: string;
      subtitle?: string;
      authors?: string[];
      publisher?: string;
      publishedDate?: string;
      industryIdentifiers?: Array<{ type: string; identifier: string }>;
      pageCount?: number;
      imageLinks?: { thumbnail?: string; smallThumbnail?: string };
      language?: string;
    };
    saleInfo?: {
      listPrice?: { amount?: number; currencyCode?: string };
      retailPrice?: { amount?: number; currencyCode?: string };
    };
  }>;
};

/** Pure: response -> CatalogueBook for the requested ISBN, or null. */
export function mapGoogleVolume(
  isbn13: string,
  response: GoogleVolumesResponse | null,
): CatalogueBook | null {
  const item =
    response?.items?.find((it) =>
      it.volumeInfo?.industryIdentifiers?.some((id) => toIsbn13(id.identifier) === isbn13),
    ) ?? response?.items?.[0];
  const v = item?.volumeInfo;
  if (!v?.title) return null;

  const year = v.publishedDate ? Number(v.publishedDate.slice(0, 4)) : NaN;
  const cover = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail ?? null;
  const price = item?.saleInfo?.listPrice ?? item?.saleInfo?.retailPrice;

  return {
    isbn13,
    title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title,
    authors: v.authors ?? [],
    publisher: v.publisher ?? null,
    publishedYear: Number.isFinite(year) && year > 1400 ? year : null,
    language: (v.language ?? "en").slice(0, 2).toLowerCase(),
    pageCount: v.pageCount && v.pageCount > 0 ? v.pageCount : null,
    // Google serves http:// thumbnails; upgrade and drop the page-curl effect.
    coverUrl: cover ? cover.replace(/^http:/, "https:").replace("&edge=curl", "") : null,
    listPricePaise:
      price?.currencyCode === "INR" && price.amount ? Math.round(price.amount * 100) : null,
    source: "google_books",
  };
}

const bucket = new TokenBucket(10, 10);

export async function fetchGoogleBooks(
  isbn13: string,
  opts: { fetcher?: Fetcher; apiKey?: string; timeoutMs?: number } = {},
): Promise<CatalogueBook | null> {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `isbn:${isbn13}`);
  url.searchParams.set("country", "IN");
  url.searchParams.set("maxResults", "3");
  if (opts.apiKey) url.searchParams.set("key", opts.apiKey);
  const options: GetJsonOptions = {
    provider: "google_books",
    fetcher: opts.fetcher,
    timeoutMs: opts.timeoutMs,
    bucket,
  };
  const json = await getJson<GoogleVolumesResponse>(url.toString(), options);
  return mapGoogleVolume(isbn13, json);
}
