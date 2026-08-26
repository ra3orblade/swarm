/**
 * Pixel art shared between the dashboard and the marketing site.
 *
 * The grid lives here so there is exactly one robot. `packages/web/public/app.js` keeps an inline
 * copy for the browser (it is a plain script and cannot import from `core`), and `art.test.ts`
 * asserts the two are identical — so the copy can never quietly drift from this one.
 *
 * Glyphs: `X` the accent, `g` a lighter tint, `d` a darker shade, space transparent.
 */

/** Head, shoulders, torso, arms and legs — the dashboard's empty state. */
export const ROBOT: readonly string[] = [
  "       g       g       ",
  "       X       X       ",
  "       X       X       ",
  "     ddddddddddddd     ",
  "     dXXXXXXXXXXXd     ",
  "     dggXXXXXXXXXd     ",
  "   dddXXddXXXddXXddd   ",
  "   dddXXddXXXddXXddd   ",
  "   dddXXXXXXXXXXXddd   ",
  "   dddXXdddddddXXddd   ",
  "     dXXXXXXXXXXXd     ",
  "     dXXXXXXXXXXXd     ",
  "     ddddddddddddd     ",
  "          XXX          ",
  "         ddddd         ",
  "      ddddddddddd      ",
  "   dXXdggXXXXXXXdXXd   ",
  "   dXXdXggggXddddXXd   ",
  "   dXXdXggggXXXXdXXd   ",
  "   dXXdXXXXXXddddXXd   ",
  "   dXXdXXXXXXXXXdXXd   ",
  "   dXXdXdddXXXXXdXXd   ",
  "   ddddXXXXXXXXXdddd   ",
  "      ddddddddddd      ",
  "        XX   XX        ",
  "        XX   XX        ",
  "       XXXX XXXX       ",
  "       dddd dddd       ",
];

/** Just the head — antennae down to the jaw. The site's mark and favicon. */
export const ROBOT_HEAD: readonly string[] = ROBOT.slice(0, 13);

/** Trim fully-blank rows and columns so an icon has no dead margin. */
export function trimArt(rows: readonly string[]): string[] {
  const w = Math.max(...rows.map((r) => r.length));
  const pad = rows.map((r) => r.padEnd(w, " "));
  const used = (c: number) => pad.some((r) => r[c] !== " ");
  let l = 0;
  let r = w - 1;
  while (l < w && !used(l)) l++;
  while (r > l && !used(r)) r--;
  return pad.filter((row) => row.trim().length > 0).map((row) => row.slice(l, r + 1));
}

/** Render a grid to a standalone SVG with literal colours (the site has no CSS custom properties). */
export function artSvg(
  rows: readonly string[],
  palette: Record<string, string>,
  opts: {
    cell?: number;
    className?: string;
    title?: string;
    /** Per-cell class, so one part can animate without the whole drawing pulsing. */
    classOf?: (glyph: string, x: number, y: number) => string | undefined;
    /** Per-cell inline style, e.g. a custom property the stylesheet staggers an animation by. */
    styleOf?: (glyph: string, x: number, y: number) => string | undefined;
  } = {},
): string {
  const cell = opts.cell ?? 6;
  const w = Math.max(...rows.map((r) => r.length)) * cell;
  const h = rows.length * cell;
  let out = "";
  // Consecutive cells of one colour become one wide rect. The drawing is identical and the file is
  // roughly a third the size, which matters when the mark is inlined on every page of the site.
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const glyph = row[x] as string;
      const fill = palette[glyph];
      if (!fill) {
        x++;
        continue;
      }
      const cls = opts.classOf?.(glyph, x, y);
      const style = opts.styleOf?.(glyph, x, y);
      let run = 1;
      while (
        x + run < row.length &&
        row[x + run] === glyph &&
        opts.classOf?.(glyph, x + run, y) === cls &&
        opts.styleOf?.(glyph, x + run, y) === style
      )
        run++;
      out += `<rect${cls ? ` class="${cls}"` : ""}${style ? ` style="${style}"` : ""} x="${x * cell}" y="${y * cell}" width="${run * cell}" height="${cell}" fill="${fill}"/>`;
      x += run;
    }
  });
  const cls = opts.className ? ` class="${opts.className}"` : "";
  const title = opts.title ? `<title>${opts.title}</title>` : "";
  return `<svg${cls} viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"${opts.title ? "" : ' aria-hidden="true"'}>${title}${out}</svg>`;
}
