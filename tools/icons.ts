/**
 * Every icon and mark Swarm ships, rendered from the one robot in `core/src/art.ts`.
 *
 * The art is flat coloured squares, so every size is an exact nearest-neighbour scale — no
 * rasteriser, no blurring, and no second copy of the drawing to keep in sync. `.icns` is built by
 * macOS's own `iconutil`; `.ico` embeds PNGs directly, which every modern Windows accepts.
 *
 * Writes the desktop/store icons, and the site's transparent marks and favicons.
 *
 *   bun tools/icons.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { ART_PALETTE, artSvg, HEAD, MARK, trimArt } from "../packages/core/src/art";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "apps/desktop/src-tauri/icons");
const site = join(root, "site");
const web = join(root, "packages/web/public");

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
const PAL: Record<string, [number, number, number]> = Object.fromEntries(
  Object.entries(ART_PALETTE).map(([k, v]) => [k, rgb(v)]),
);
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

type Art = { rows: string[]; cols: number; h: number };
const prep = (grid: readonly string[]): Art => {
  const rows = trimArt(grid);
  return { rows, cols: (rows[0] as string).length, h: rows.length };
};
const BIG = prep(HEAD);
const SMALL = prep(MARK);

/** Whole-pixel cell size for this art in this tile; 0 when it cannot fit at all. */
const cellFor = (size: number, a: Art) => Math.floor((size * 0.86) / Math.max(a.cols, a.h));
/** How much of the tile's width the art covers. 0 means it does not fit. */
const fit = (size: number, a: Art) => (cellFor(size, a) * a.cols) / size;

/**
 * The detailed head wherever it both fits the tile and gets at least 2px a cell; the simple one
 * everywhere else. One pixel a cell is the mush case — 47 columns of bevel, ear pods and eye
 * sockets rendered a pixel each is noise, not a robot. Whole-pixel cells also quantise hard at
 * this scale: at 150px the head can only take 2px cells, covering 63% of the tile and reading as
 * shrunken, where the simple mark takes 10px cells and fills it.
 */
const artFor = (size: number): Art =>
  cellFor(size, BIG) >= 2 && fit(size, BIG) >= 0.65 ? BIG : SMALL;

/**
 * One square icon: rounded dark tile, art centred on it.
 *
 * The cell size is a whole number of pixels, always. Scaling by `size / box` looks reasonable and
 * is what makes small icons mushy — at 32px that was 1.6 pixels a cell, so cells landed on two
 * pixels or one depending where they fell and the eyes came out different sizes. Picking an
 * integer cell and centring the result costs a little tile coverage and keeps every pixel square.
 *
 * `inset` reserves a transparent margin around the tile. macOS wants one: its icon grid puts the
 * rounded square at about 80% of the canvas, and an icon that bleeds to the edge sits visibly
 * larger in the Dock than every icon beside it.
 */
function png(
  size: number,
  { radius, art, inset = 0 }: { radius?: number; art?: Art; inset?: number } = {},
): Buffer {
  const m = Math.round(size * inset);
  const tile = size - m * 2;
  // Pick the art from the tile, not the canvas: with the macOS inset a 128px icon only has 102px
  // of tile, which is under 2px a cell for the detailed head even though 128 is over it.
  const chosen = art ?? artFor(tile);
  const { rows: grid, cols, h: rows } = chosen;
  const r = radius ?? tile * 0.2237; // the macOS corner, 185.4/824
  const cell = Math.max(1, cellFor(tile, chosen));
  const ox = m + Math.round((tile - cols * cell) / 2);
  const oy = m + Math.round((tile - rows * cell) / 2);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  const outside = (x: number, y: number) => {
    if (x < m || y < m || x >= size - m || y >= size - m) return true;
    const lo = m + r;
    const hi = size - m - r - 1;
    const near = (cx: number, cy: number) => (x - cx) ** 2 + (y - cy) ** 2 > r ** 2;
    return (
      (x < lo && y < lo && near(lo, lo)) ||
      (x > hi && y < lo && near(hi, lo)) ||
      (x < lo && y > hi && near(lo, hi)) ||
      (x > hi && y > hi && near(hi, hi))
    );
  };
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const off = outside(x, y);
      let col = BG;
      const gx = Math.floor((x - ox) / cell);
      const gy = Math.floor((y - oy) / cell);
      if (!off && gy >= 0 && gy < rows && gx >= 0 && gx < cols) {
        const hit = PAL[(grid[gy] as string)[gx] as string];
        if (hit) col = hit;
      }
      raw[p++] = col[0];
      raw[p++] = col[1];
      raw[p++] = col[2];
      raw[p++] = off ? 0 : 255;
    }
  }
  return encode(size, size, raw);
}

/** Wrap raw RGBA scanlines (each already prefixed with its filter byte) as a PNG. */
function encode(w: number, h: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The drawing alone on transparency, at an exact integer scale — no tile, no rounding, no
 * padding. This is what the site puts on the page, so it stays crisp under image-rendering:
 * pixelated at any size the layout gives it.
 */
function sprite({ rows: grid, cols, h }: Art, scale: number): Buffer {
  const w = cols * scale;
  const raw = Buffer.alloc((w * 4 + 1) * h * scale);
  let p = 0;
  for (let y = 0; y < h * scale; y++) {
    raw[p++] = 0;
    const row = grid[Math.floor(y / scale)] as string;
    for (let x = 0; x < w; x++) {
      const hit = PAL[row[Math.floor(x / scale)] as string];
      raw[p++] = hit ? hit[0] : 0;
      raw[p++] = hit ? hit[1] : 0;
      raw[p++] = hit ? hit[2] : 0;
      raw[p++] = hit ? 255 : 0;
    }
  }
  return encode(w, h * scale, raw);
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
// Apple's icon grid keeps the rounded square at ~80% of the canvas. Below 128px there are
// not enough pixels to spend on a margin — a 32px icon would be left with 26px of tile.
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
  writeFileSync(join(set, name), png(size, { inset: size >= 128 ? 0.0977 : 0 }));
let icns = false;
try {
  execFileSync("iconutil", ["-c", "icns", set, "-o", join(out, "icon.icns")]);
  rmSync(set, { recursive: true, force: true });
  icns = true;
} catch {
  // iconutil is macOS-only; on other platforms the .icns in the tree stays as it is.
}

// ── the site's own marks ────────────────────────────────────────────────────
// Transparent, unpadded, and emitted at exactly the size the page displays them. Pixel art only
// stays crisp at whole-number scales: `image-rendering: pixelated` saves an upscale, but nothing
// saves a downscale — 304px of art squeezed into 190 drops every eighth column and the eyes come
// out lopsided. So the scale lives here, next to the CSS width it has to agree with.
const HERO = 6; //   site/index.html  .hero .mark  { width: 282px }  = 47 cells x 6
const HEADER = 2; // site/index.html  header .mark { width:  32px }  = 16 cells x 2

/**
 * macOS menu-bar icon. The bar draws template images itself — it takes the alpha channel and
 * paints it in whatever colour the bar is currently using, inverting on dark and dimming when the
 * app is inactive. So this carries no colour at all: the head is opaque black and the eyes and
 * mouth are punched out of it, which is what makes it read as a face once the bar fills it in.
 *
 * 44px is 22pt at 2x, the exact height of the menu bar on a retina display, so the cells land on
 * whole device pixels rather than being resampled.
 */
function template(a: Art, size: number): Buffer {
  const cell = Math.floor(size / Math.max(a.cols, a.h));
  const ox = Math.round((size - a.cols * cell) / 2);
  const oy = Math.round((size - a.h * cell) / 2);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - ox) / cell);
      const gy = Math.floor((y - oy) / cell);
      const g =
        gy >= 0 && gy < a.h && gx >= 0 && gx < a.cols ? (a.rows[gy] as string)[gx] : undefined;
      // "S" is the eyes and the mouth: holes, not ink.
      const on = g !== undefined && g !== " " && g !== "S";
      raw[p++] = 0;
      raw[p++] = 0;
      raw[p++] = 0;
      raw[p++] = on ? 255 : 0;
    }
  }
  return encode(size, size, raw);
}
writeFileSync(join(out, "tray.png"), template(SMALL, 44));

writeFileSync(join(site, "head.png"), sprite(BIG, HERO));
writeFileSync(join(site, "mark.png"), sprite(SMALL, HEADER));
writeFileSync(join(site, "apple-touch-icon.png"), png(180, { art: SMALL }));
writeFileSync(join(site, "favicon.ico"), ico([16, 32, 48]));
writeFileSync(
  join(site, "favicon.svg"),
  artSvg(SMALL.rows, ART_PALETTE, {
    title: "Swarm",
    cell: 1,
    tile: { fill: "#0e1013", pad: 2, radius: 4 },
  }),
);

// ── the dashboard's own favicon ─────────────────────────────────────────────
// It used to be a data: URL pasted into index.html, which is exactly the kind of second copy that
// goes stale — it was still the pre-redraw robot long after everything else had changed. The
// dashboard now links these two files and the daemon serves them.
writeFileSync(join(web, "favicon.ico"), ico([16, 32, 48]));
writeFileSync(
  join(web, "favicon.svg"),
  artSvg(SMALL.rows, ART_PALETTE, {
    title: "Swarm",
    cell: 1,
    tile: { fill: "#0e1013", pad: 2, radius: 4 },
  }),
);

console.log(
  `icons: ${files.length} png + icon.ico + tray.png${icns ? " + icon.icns" : ""} → ${out}\n` +
    "       favicon.ico, favicon.svg → packages/web/public\n" +
    `       head.png, mark.png, apple-touch-icon.png, favicon.ico, favicon.svg → ${site}` +
    (icns ? "" : "\n       (icon.icns needs macOS iconutil)"),
);
