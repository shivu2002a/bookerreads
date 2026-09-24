/**
 * ISBN helpers. Everything downstream works with ISBN-13 strings of 13 digits.
 */

/** Strips hyphens and spaces; upper-cases a trailing X. Returns null if the shape is wrong. */
export function normaliseIsbn(raw: string): string | null {
  const s = raw.replace(/[-\s]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) return s;
  if (/^\d{9}[\dX]$/.test(s)) return s;
  return null;
}

export function isValidIsbn10(isbn10: string): boolean {
  if (!/^\d{9}[\dX]$/.test(isbn10)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(isbn10[i]);
  const check = isbn10[9] === "X" ? 10 : Number(isbn10[9]);
  return (sum + check) % 11 === 0;
}

export function isbn13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidIsbn13(isbn13: string): boolean {
  if (!/^\d{13}$/.test(isbn13)) return false;
  return isbn13CheckDigit(isbn13.slice(0, 12)) === Number(isbn13[12]);
}

/** ISBN-10 to ISBN-13 (978 prefix). Assumes the input is a valid ISBN-10. */
export function isbn10To13(isbn10: string): string {
  const first12 = `978${isbn10.slice(0, 9)}`;
  return `${first12}${isbn13CheckDigit(first12)}`;
}

/**
 * Accepts any user or scanner input and returns a validated ISBN-13, or null.
 * EAN-13 barcodes on books are the ISBN-13, so scanner output goes straight in.
 */
export function toIsbn13(raw: string): string | null {
  const n = normaliseIsbn(raw);
  if (!n) return null;
  if (n.length === 13) return isValidIsbn13(n) ? n : null;
  return isValidIsbn10(n) ? isbn10To13(n) : null;
}

/** True when the text looks like an ISBN query rather than a title search. */
export function looksLikeIsbn(query: string): boolean {
  return normaliseIsbn(query.trim()) !== null;
}
