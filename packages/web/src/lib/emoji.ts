/**
 * Emoji for the project icon picker.
 *
 * A short row of likely candidates, and behind "…" every emoji the platform font can draw, by
 * Unicode block — no names, but browseable; the OS picker (⌃⌘Space on macOS, Win+. on Windows)
 * covers search.
 *
 * Which code points the platform font actually draws in colour is a per-machine answer, so it is
 * probed once and remembered. The probe is one `getImageData` readback per block over a grid of
 * glyphs, deduped across the blocks that overlap, and cached in localStorage across reloads.
 */

export const PROJECT_EMOJI = [
  "🐝",
  "🚀",
  "🧪",
  "📦",
  "🛠️",
  "🌐",
  "📊",
  "🤖",
  "🧠",
  "🎨",
  "🔒",
  "📚",
  "💬",
  "🏗️",
  "🧩",
  "⚡",
];

const EMOJI_BLOCKS: [name: string, from: number, to: number][] = [
  ["Smileys & people", 0x1f600, 0x1f64f],
  ["Gestures & body", 0x1f440, 0x1f4ff],
  ["Animals & nature", 0x1f400, 0x1f43f],
  ["Food", 0x1f32d, 0x1f37f],
  ["Activity & travel", 0x1f680, 0x1f6ff],
  ["Objects", 0x1f4a0, 0x1f4ff],
  ["Symbols", 0x1f300, 0x1f32c],
  ["More", 0x1f900, 0x1f9ff],
  ["Extended", 0x1fa70, 0x1faff],
  ["Misc", 0x2600, 0x26ff],
  ["Dingbats", 0x2700, 0x27bf],
];

const CACHE_KEY = "swarm.emoji.v1";

export interface EmojiBlock {
  name: string;
  emoji: string[];
}

let cached: EmojiBlock[] | null = null;

/** Which code points in `[from, to]` the font paints in colour — i.e. draws as an emoji. */
function detectEmoji(from: number, to: number): string[] {
  const S = 20;
  const COLS = 32;
  const n = to - from + 1;
  const rows = Math.ceil(n / COLS);
  const canvas = document.createElement("canvas");
  canvas.width = COLS * S;
  canvas.height = rows * S;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.font = `${S - 4}px system-ui`;
  ctx.textBaseline = "top";
  for (let i = 0; i < n; i++) {
    ctx.fillText(String.fromCodePoint(from + i), (i % COLS) * S, Math.floor(i / COLS) * S);
  }
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = (i % COLS) * S;
    const y0 = Math.floor(i / COLS) * S;
    if (paintsColour(data, canvas.width, x0, y0, S)) out.push(String.fromCodePoint(from + i));
  }
  return out;
}

/** Whether any pixel in the `size`² cell at (x0, y0) is opaque and not grey — a colour glyph. */
function paintsColour(
  data: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  size: number,
): boolean {
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const p = (y * width + x) * 4;
      const r = data[p] ?? 0;
      const g = data[p + 1] ?? 0;
      const b = data[p + 2] ?? 0;
      const alpha = data[p + 3] ?? 0;
      if (alpha > 40 && (Math.abs(r - g) > 24 || Math.abs(g - b) > 24)) return true;
    }
  }
  return false;
}

/** Every emoji this machine can draw, grouped by block. Probed once, then cached. */
export function emojiBlocks(): EmojiBlock[] {
  if (cached) return cached;
  // Keyed by the UA (a font change is what would invalidate it) plus the block list.
  const sig = `${navigator.userAgent}|${EMOJI_BLOCKS.map((b) => b.join(":")).join(",")}`;
  let lists: string[][] | null = null;
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as {
      sig?: string;
      blocks?: string[][];
    } | null;
    if (hit?.sig === sig && Array.isArray(hit.blocks)) lists = hit.blocks;
  } catch {
    // Corrupt or unavailable cache: probe again.
  }
  if (!lists) {
    const seen = new Set<string>();
    lists = EMOJI_BLOCKS.map(([, from, to]) =>
      detectEmoji(from, to).filter((e) => !seen.has(e) && seen.add(e)),
    );
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ sig, blocks: lists }));
    } catch {
      // Private mode or quota: the probe just runs again next time.
    }
  }
  const probed = lists;
  cached = EMOJI_BLOCKS.map(([name], i) => ({ name, emoji: probed[i] ?? [] })).filter(
    (b) => b.emoji.length > 0,
  );
  return cached;
}

/** Downsize an image file to a square 64px PNG data URL, centre-cropped — never letterboxed. */
export function fileToIconDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const S = 64;
      const canvas = document.createElement("canvas");
      canvas.width = S;
      canvas.height = S;
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      canvas.getContext("2d")?.drawImage(img, sx, sy, side, side, 0, 0, S, S);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("not an image the browser can decode"));
    };
    img.src = url;
  });
}
