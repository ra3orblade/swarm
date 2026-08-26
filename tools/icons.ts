/**
 * Desktop and store icons, rendered from the one robot in `core/src/art.ts`.
 *
 * The art is flat coloured squares, so every size is an exact nearest-neighbour scale — no
 * rasteriser, no blurring, and no second copy of the drawing to keep in sync. `.icns` is built by
 * macOS's own `iconutil`; `.ico` embeds PNGs directly, which every modern Windows accepts.
 *
 *   bun tools/icons.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { ROBOT_HEAD, trimArt } from "../packages/core/src/art";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "apps/desktop/src-tauri/icons");

const PAL: Record<string, [number, number, number]> = {
  X: [0xa3, 0xe6, 0x35],
  g: [0xd6, 0xf4, 0xa4],
  d: [0x5f, 0x85, 0x1f],
};
const BG: [number, number, number] = [0x0e, 0x10, 0x13];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const byte of b) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** Width of an existing PNG, read straight from its IHDR — the set defines its own sizes. */
function pngSize(file: string): number | null {
  try {
    const b = readFileSync(file);
    return b.length > 24 && b.toString("ascii", 12, 16) === "IHDR" ? b.readUInt32BE(16) : null;
  } catch {
    return null;
  }
}

const art = trimArt(ROBOT_HEAD);
const cols = (art[0] as string).length;
const rows = art.length;

/** One square icon: rounded dark tile, robot centred, nearest-neighbour so pixels stay pixels. */
function png(size: number, { radius = size * 0.22, pad = 2 } = {}): Buffer {
  const box = Math.max(cols, rows) + pad * 2;
  const ox = Math.round((box - cols) / 2);
  const oy = Math.round((box - rows) / 2);
  const scale = size / box;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  const outside = (x: number, y: number) => {
    const near = (cx: number, cy: number) => (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2;
    return (
      (x < radius && y < radius && near(radius, radius)) ||
      (x >= size - radius && y < radius && near(size - radius - 1, radius)) ||
      (x < radius && y >= size - radius && near(radius, size - radius - 1)) ||
      (x >= size - radius && y >= size - radius && near(size - radius - 1, size - radius - 1))
    );
  };
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const off = outside(x, y);
      let col = BG;
      const gx = Math.floor(x / scale) - ox;
      const gy = Math.floor(y / scale) - oy;
      if (!off && gy >= 0 && gy < rows && gx >= 0 && gx < cols) {
        const hit = PAL[(art[gy] as string)[gx] as string];
        if (hit) col = hit;
      }
      raw[p++] = col[0];
      raw[p++] = col[1];
      raw[p++] = col[2];
      raw[p++] = off ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A multi-size .ico, each entry a PNG. 0 in the size byte means 256. */
function ico(sizes: number[]): Buffer {
  const imgs = sizes.map((s) => png(s, { radius: s * 0.18 }));
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let offset = 6 + sizes.length * 16;
  const entries: Buffer[] = [];
  sizes.forEach((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE((imgs[i] as Buffer).length, 8);
    e.writeUInt32LE(offset, 12);
    offset += (imgs[i] as Buffer).length;
    entries.push(e);
  });
  return Buffer.concat([dir, ...entries, ...imgs]);
}

const files: Array<[string, number]> = [
  ["32x32.png", 32],
  ["64x64.png", 64],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
  ["Square30x30Logo.png", 30],
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
  ["Square89x89Logo.png", 89],
  ["StoreLogo.png", 50],
];
for (const [name, size] of files) writeFileSync(join(out, name), png(size));
writeFileSync(join(out, "icon.ico"), ico([16, 32, 48, 64, 128, 256]));

// iOS and Android ship their own sets. Their sizes are in the filenames, so they are derived
// rather than listed — a set that gains a size keeps working without touching this file.
for (const sub of ["ios", "android"]) {
  const dir = join(out, sub);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) {
      for (const g of readdirSync(join(dir, f.name))) {
        if (!g.endsWith(".png")) continue;
        const cur = pngSize(join(dir, f.name, g));
        if (cur) writeFileSync(join(dir, f.name, g), png(cur, { radius: 0 }));
      }
      continue;
    }
    if (!f.name.endsWith(".png")) continue;
    const cur = pngSize(join(dir, f.name));
    if (cur) writeFileSync(join(dir, f.name), png(cur, { radius: 0 }));
  }
}

// macOS wants an .iconset folder handed to iconutil.
const set = join(out, "icon.iconset");
rmSync(set, { recursive: true, force: true });
mkdirSync(set, { recursive: true });
for (const [name, size] of [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
] as Array<[string, number]>)
  writeFileSync(join(set, name), png(size));
try {
  execFileSync("iconutil", ["-c", "icns", set, "-o", join(out, "icon.icns")]);
  rmSync(set, { recursive: true, force: true });
  console.log(`icons: ${files.length} png + icon.ico + icon.icns → ${out}`);
} catch {
  console.log(`icons: ${files.length} png + icon.ico → ${out} (icon.icns needs macOS iconutil)`);
}
