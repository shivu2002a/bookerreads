import { getJson, TokenBucket, type GetJsonOptions } from "../http";
import type { CatalogueBook, Fetcher } from "../types";

export type OlEdition = {
  title?: string;
  subtitle?: string;
  authors?: Array<{ key: string }>;
  works?: Array<{ key: string }>;
  publishers?: string[];
  publish_date?: string;
  number_of_pages?: number;
  covers?: number[];
  languages?: Array<{ key: string }>; // "/languages/eng"
};
export type OlWork = { authors?: Array<{ author?: { key: string } }> };
export type OlAuthor = { name?: string };

const OL_LANG_TO_ISO: Record<string, string> = {
  eng: "en",
  hin: "hi",
  kan: "kn",
  tam: "ta",
  tel: "te",
  mal: "ml",
  mar: "mr",
  ben: "bn",
  guj: "gu",
  urd: "ur",
  fre: "fr",
  ger: "de",
  spa: "es",
  ita: "it",
  por: "pt",
  rus: "ru",
  jpn: "ja",
};

/** Pure: edition + resolved author names -> CatalogueBook, or null. */
export function mapOpenLibraryEdition(
  isbn13: string,
  edition: OlEdition | null,
  authorNames: string[],
): CatalogueBook | null {
  if (!edition?.title) return null;
  const yearMatch = edition.publish_date?.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  const langKey = edition.languages?.[0]?.key?.split("/").pop() ?? "eng";
  const coverId = edition.covers?.find((c) => c > 0);
  return {
    isbn13,
    title: edition.subtitle ? `${edition.title}: ${edition.subtitle}` : edition.title,
    authors: authorNames,
    publisher: edition.publishers?.[0] ?? null,
    publishedYear: yearMatch ? Number(yearMatch[1]) : null,
    language: OL_LANG_TO_ISO[langKey] ?? "en",
    pageCount:
      edition.number_of_pages && edition.number_of_pages > 0 ? edition.number_of_pages : null,
    coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null,
    listPricePaise: null, // Open Library has no price data
    source: "open_library",
  };
}

const bucket = new TokenBucket(10, 10);
const HEADERS = { "User-Agent": "BookerReads/0.1 (catalogue lookup; hello@bookerreads.in)" };

/**
 * Edition by ISBN; author names come from the edition's `authors` or, failing
 * that, the first work's authors. Extra requests are bounded to 3 authors.
 */
export async function fetchOpenLibrary(
  isbn13: string,
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<CatalogueBook | null> {
  const base: Omit<GetJsonOptions, "provider"> = {
    fetcher: opts.fetcher,
    timeoutMs: opts.timeoutMs,
    headers: HEADERS,
  };
  const edition = await getJson<OlEdition>(`https://openlibrary.org/isbn/${isbn13}.json`, {
    ...base,
    provider: "open_library",
    bucket,
  });
  if (!edition) return null;

  let authorKeys = edition.authors?.map((a) => a.key) ?? [];
  if (authorKeys.length === 0 && edition.works?.[0]) {
    const work = await getJson<OlWork>(`https://openlibrary.org${edition.works[0].key}.json`, {
      ...base,
      provider: "open_library",
      retries: 0,
    }).catch(() => null);
    authorKeys =
      work?.authors?.map((a) => a.author?.key).filter((k): k is string => Boolean(k)) ?? [];
  }

  const names = await Promise.all(
    authorKeys.slice(0, 3).map((key) =>
      getJson<OlAuthor>(`https://openlibrary.org${key}.json`, {
        ...base,
        provider: "open_library",
        retries: 0,
      })
        .then((a) => a?.name ?? null)
        .catch(() => null),
    ),
  );
  return mapOpenLibraryEdition(
    isbn13,
    edition,
    names.filter((n): n is string => Boolean(n)),
  );
}
