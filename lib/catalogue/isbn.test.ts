import { describe, expect, it } from "vitest";
import {
  isValidIsbn10,
  isValidIsbn13,
  isbn10To13,
  looksLikeIsbn,
  normaliseIsbn,
  toIsbn13,
} from "./isbn";

describe("isbn", () => {
  it("normalises hyphens, spaces, and case", () => {
    expect(normaliseIsbn("978-0-06-231609-7")).toBe("9780062316097");
    expect(normaliseIsbn("0 06 231609 x")).toBe("006231609X");
    expect(normaliseIsbn("not an isbn")).toBeNull();
    expect(normaliseIsbn("12345")).toBeNull();
  });

  it("validates ISBN-13 check digits", () => {
    expect(isValidIsbn13("9780062316097")).toBe(true); // Sapiens
    expect(isValidIsbn13("9780143127741")).toBe(true); // The Martian
    expect(isValidIsbn13("9780062316098")).toBe(false);
    expect(isValidIsbn13("978006231609")).toBe(false);
  });

  it("validates ISBN-10 check digits including X", () => {
    expect(isValidIsbn10("0306406152")).toBe(true);
    expect(isValidIsbn10("080442957X")).toBe(true);
    expect(isValidIsbn10("0306406153")).toBe(false);
  });

  it("converts ISBN-10 to ISBN-13", () => {
    expect(isbn10To13("0306406152")).toBe("9780306406157");
    expect(isbn10To13("080442957X")).toBe("9780804429573");
  });

  it("toIsbn13 accepts either form and rejects bad check digits", () => {
    expect(toIsbn13("978-0-06-231609-7")).toBe("9780062316097");
    expect(toIsbn13("0-306-40615-2")).toBe("9780306406157");
    expect(toIsbn13("0306406153")).toBeNull();
    expect(toIsbn13("9780062316098")).toBeNull();
    expect(toIsbn13("Sapiens")).toBeNull();
  });

  it("distinguishes ISBN queries from title queries", () => {
    expect(looksLikeIsbn(" 9780062316097 ")).toBe(true);
    expect(looksLikeIsbn("0306406152")).toBe(true);
    expect(looksLikeIsbn("harari")).toBe(false);
    expect(looksLikeIsbn("1984")).toBe(false);
  });
});
