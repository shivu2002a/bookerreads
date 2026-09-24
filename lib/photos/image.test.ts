import { describe, expect, it } from "vitest";
import { fitWithin, GALLERY_AGE_THRESHOLD_MS, isLikelyGalleryPick } from "./image";

describe("fitWithin", () => {
  it("leaves small images alone", () => {
    expect(fitWithin(1200, 900)).toEqual({ width: 1200, height: 900, scaled: false });
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600, scaled: false });
  });

  it("scales landscape by width", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200, scaled: true });
  });

  it("scales portrait by height", () => {
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600, scaled: true });
  });

  it("rounds and never yields zero", () => {
    expect(fitWithin(10000, 3)).toEqual({ width: 1600, height: 1, scaled: true });
  });
});

describe("isLikelyGalleryPick", () => {
  const now = 1_700_000_000_000;
  it("treats a just-taken photo as a camera capture", () => {
    expect(isLikelyGalleryPick({ lastModified: now - 2_000 }, now)).toBe(false);
    expect(isLikelyGalleryPick({ lastModified: now - GALLERY_AGE_THRESHOLD_MS }, now)).toBe(false);
  });
  it("treats an old file as a gallery pick", () => {
    expect(isLikelyGalleryPick({ lastModified: now - GALLERY_AGE_THRESHOLD_MS - 1 }, now)).toBe(
      true,
    );
    expect(isLikelyGalleryPick({ lastModified: now - 86_400_000 }, now)).toBe(true);
  });
});
