/**
 * Client-side photo processing (Requirement 14.4): long edge <= 1600 px, JPEG q=0.8.
 * The maths is separated from the DOM work so it can be unit tested.
 */

export const MAX_LONG_EDGE = 1600;
export const JPEG_QUALITY = 0.8;
/** Photos picked from the gallery are typically older than this. */
export const GALLERY_AGE_THRESHOLD_MS = 60_000;

export function fitWithin(
  width: number,
  height: number,
  maxLongEdge = MAX_LONG_EDGE,
): { width: number; height: number; scaled: boolean } {
  const long = Math.max(width, height);
  if (long <= maxLongEdge) return { width, height, scaled: false };
  const ratio = maxLongEdge / long;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

/**
 * Requirement 2.3: reject gallery uploads. Browsers give no direct signal, so
 * we use the file's modification time: a photo just taken has lastModified
 * within seconds of now; a gallery pick is usually minutes to years old.
 */
export function isLikelyGalleryPick(file: { lastModified: number }, now = Date.now()): boolean {
  return now - file.lastModified > GALLERY_AGE_THRESHOLD_MS;
}

export type ProcessedPhoto = {
  blob: Blob;
  width: number;
  height: number;
  originalBytes: number;
};

/** Browser only. Decodes, resizes, re-encodes as JPEG (which also strips EXIF). */
export async function processPhoto(file: Blob): Promise<ProcessedPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/jpeg",
        JPEG_QUALITY,
      ),
    );
    return { blob, width, height, originalBytes: file.size };
  } finally {
    bitmap.close();
  }
}
