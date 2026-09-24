/**
 * Generates public/icons/icon-{192,512}.png and maskable variants with no
 * image library: a navy square with a lighter "book" block. Replace with real
 * artwork before launch; the manifest only needs valid PNGs of these sizes.
 *
 *   pnpm tsx scripts/make-icons.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const NAVY = [15, 23, 42];
const PAPER = [248, 250, 252];
const SPINE = [251, 191, 36];

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size: number, pixel: (x: number, y: number) => number[]): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * (size * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Book glyph centred in the square; `inset` leaves a safe zone for maskable icons. */
function bookIcon(size: number, inset: number) {
  return (x: number, y: number) => {
    const u = x / size;
    const v = y / size;
    const left = inset + 0.18;
    const right = 1 - inset - 0.18;
    const top = inset + 0.14;
    const bottom = 1 - inset - 0.14;
    if (u >= left && u <= right && v >= top && v <= bottom) {
      return u < left + 0.09 ? SPINE : PAPER;
    }
    return NAVY;
  };
}

const dir = path.resolve(process.cwd(), "public/icons");
mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(path.join(dir, `icon-${size}.png`), png(size, bookIcon(size, 0)));
  writeFileSync(path.join(dir, `maskable-${size}.png`), png(size, bookIcon(size, 0.1)));
}
writeFileSync(path.join(dir, "apple-touch-icon.png"), png(180, bookIcon(180, 0)));
console.log("icons written to public/icons");
