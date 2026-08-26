/**
 * Pixel art shared between the dashboard, the desktop icons and the marketing site.
 *
 * The grids live here so there is exactly one robot. `packages/web/public/app.js` keeps an inline
 * copy for the browser (it is a plain script and cannot import from `core`), and `art.test.ts`
 * asserts the two are identical — so the copy can never quietly drift from this one.
 *
 * Glyphs are a seven-step ramp, darkest to lightest: `O` `K` `D` `S` `E` `M` `L`, where `M` is the
 * accent itself. A space is transparent. The ramp is a straight scale of the accent toward black
 * (and, for `L`, toward white), so every tone is the same hue and the drawing recolours with the
 * brand by changing one value.
 */

/** The whole robot. Wants roughly 2px a cell to read — below ~128px use MARK instead. */
export const ROBOT: readonly string[] = [
  "                        MM                     MM                        ",
  "                        LL                     LL                        ",
  "                        LL                     LL                        ",
  "                        LM                     MM                        ",
  "                        MD                     MS                        ",
  "                        LE                     LE                        ",
  "                        ME                     ME                        ",
  "                        MS                     MS                        ",
  "                        KK                     KK                        ",
  "                   SSDDDSDDDDDDDDDDDDDDDDDDDDDDDDDDDDS                   ",
  "                   SSDSDDDDDDDDDDDDDDDDDDDDDDDDDDDDDSS                   ",
  "                   SSDOOOOOOOOOOOOOOOOOOOOOOOOOOOOOKSS                   ",
  "                   SSOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMOSS                   ",
  "                   DDKMMLLLMLLMMMMMMMMMMMMMMMMMMMMMODD                   ",
  "                   DDOMMLMMMMMMMMMMMMMMMMMMMMMMMMMMODD                   ",
  "              SSSS DDOMMLMMMMMMMMMMMMMMMMMMMMMMMMMMODD SSSS              ",
  "              SSSS DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD SSSS              ",
  "             SMMMM DDOMMLMMMMMMMMMMMMMMMMMMMMMMMMMMODD SMMMS             ",
  "             DMSSS DDOMMMMOOOOOOMMMMMMMMMOOOOOOMMMMODD SSSED             ",
  "             DSSSS DDOMMMMODDDDDMMMMMMMMMODDDDDMMMMODD SSSSK             ",
  "             DSMMS DDOMMMMDDDDDDMMMMMMMMMKDDDDDMMMMODD SMMSK             ",
  "             DSSSS DDOMMMMDDDDDDMMMMMMMMMDDDDDDMMMMODD SSSSK             ",
  "             DSSSS DDOMMMMDDDDDDMMMMMMMMMDDDDDDMMMMODD DSSSK             ",
  "             DSSSS DDOMMMMDDDDDDMMMMMMMMMDDDDDDMMMMODD DSSSK             ",
  "             DSSSK DDOMMMMDDDDDDMMMMMMMMMDDDDDDMMMMODD DSSSD             ",
  "             OKKKK DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD KKKKO             ",
  "              KKKK DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD OKKK              ",
  "              KKKO DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD OKKK              ",
  "                   DDOMMMMDDDDDDDDDDDDDDDDDDDDDMMMMODD                   ",
  "                   DDOMMMMDDDDDDDDDDDDDDDDDDDDDMMMMODD                   ",
  "                   DDOMMMMDDDDDDDDDDDDDDDDDDDDDMMMMODD                   ",
  "                   DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD                   ",
  "                   DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD                   ",
  "                   DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD                   ",
  "                   DDDOOOOOOOOOOOOOOOOOOOOOOOOOOOOOKDD                   ",
  "                   DDDDDDDDDDDDDDDDDDDDDDDDDDDDDKDDDDD                   ",
  "                   DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD                   ",
  "                                                                         ",
  "                               OODDDDDKKOO                               ",
  "                               DSMMMMMMSDD                               ",
  "                                 OOOOOOO                                 ",
  "                              KDSMMMMMESSKK                              ",
  "                   MMMMMMSSK OKDSMMMMMSSSDKO DSEMMMMMM                   ",
  "         SSSSDO   MMMMMMSSKKO               OKSSSMMMMMM   ODSSSS         ",
  "        EEESSSSO LLLLMMMMMESSSSSSSSSSSSSSSSSSSSMMMMMLLLL OSSSSMME        ",
  "       SMMSSSSK EELLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLEE OSSSSEMS       ",
  "      DSSSSSSSO SEEKSMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMSOEED OSSSSSSSK      ",
  "      DSSSSSSDO SEOSKEMMMMMMMMMMMMMMMMMMMMMMMMMMMMMEOSDED ODSSSSSSK      ",
  "      KSSSSSSKO DSSOSEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEESOEED OKSSSSSSK      ",
  "      DKSSSSKKO DSMEEMLLLLLLLLLLLLLLLLLLLLLLLLLLLLLMSEMSD OKKSSSSDK      ",
  "      OKDDKDKKO KSMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMSK OKKKKKKKO      ",
  "       OOOOKKKO KSMMMMESSSSSSSSSSSSSMMMMEEEEEESSSSEMMMMSK OKKKOOOO       ",
  "       OOO  KKO KSMMMSSKKKKKKKKKKKKKKMMMDKOOOOOOOODDMMMSK OKK  OOO       ",
  "      OKSSK  O  KSMMMKKMLLLLLLLLLLLMKMMMDDSSSSSSSSDDMMMSK  O  DSSKO      ",
  "      SDOKKK    KSMMMKDLLLLLLLLLLLLLKMMMKDKKKDDKKKDKMMMSK    KKKKDS      ",
  "     DMLLMKO    KSMMMKDLLLLLLLLLLLLLKMMMDDDDDDDDDSKDMMMSK    ODMLLMD     ",
  "     DELLMSD    KSMMMKKMLLLLLLLLLLLLKMMMDKKKKKKKKKDDMMMSK    DSMLLEO     ",
  "    KSKKKKDO    KSMMMEDDDDKKDDDKKKDKSMMMDDDDDDDDDSDDMMMSK    ODDKKKSK    ",
  "    EMLLMDO     KSMMMMLLLLLLLLLLLLLLLMMMDOOOOOOOOODDMMMSK     ODMLLME    ",
  "    KMLLMSD     KSMMMMMMMMMMMMMMMMMMMMMMDDSSDDSSSSDDMMMSK     SSMLLEK    ",
  "   KSKKKKSO     KSMMMMMOOMMOOMKOEMOOMMMMDOOOOOOOOODDMMMSK     OSKKKKSO   ",
  "   SMLLMDO      KSMMMMMKKMMKKMDKEMKKMMMMKDDDDSSSSDDDMMMSK      ODMLLMS   ",
  "   SMMMMSD      KSMMMMMEEMMEEMEEMMEEMMMMDSOOOOOOOODDMMSSK      DSMMMMD   ",
  "                KSSMMMMMMMMMMMMMMMMMMMMMDDDDDDDDDDDDMSSSK                ",
  " KSMLLLMMSKO    KSSSSMMMMMMMMMMMMMMMMMMMSOOOOOOOOOOSSSSSK    OKSMLLLLMSO ",
  " DSMMMEEESKK    KSSKSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSOSSK    KDSMMMMMESD ",
  " DSMMMMMESKK    KSO KSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSO KSK    KKSMMMMMMSD ",
  " DSMMMMMESKK    OKSKSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSDSKO    KDSMMMMMMSD ",
  " KDDDDDDDDKK      KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK      KKDDDDDDDDO ",
  " O OOOOOO                                                       OOOOOO O ",
  "DSDO     OSSO        ODKKKKKKK             OKKKKKKKO        KEDO     ODEK",
  "SMDO     OSMD        KDSSSSSSK             KDSSSSSKO        SMDO     ODMS",
  "DEK       OED         OOKKKOOO             OOOKKOOO         SSO       KMS",
  "DEK       OED         SEMMMMSK             OSMMMMED         SSK       KES",
  "DSSO     OESK         SEMMMMSK             OSMMMMED         KSSO     OSSK",
  "KSMS     EEDO          OKKKKK               OKKKKK          OSEE     EMSO",
  " DSS     SSK          OSEEESDO             ODSEEESO          KSS     SSD ",
  " OOO     OO           SEMMMMSK             OSMMMMED           OO     OOO ",
  "                      KSSSSSDO             OKSSESSK                      ",
  "                   DKKDDDDDDKKDK         KDKDDDDDDDKDK                   ",
  "                  SSMLLMMMMMMLMSK       DSSMMMMMMMLLMSS                  ",
  "                  SMLMMMMMMMMLLED       SEMMMMMMMMMMLMS                  ",
  "                 DMMMMMMMMMMMMMMD       SMMMMMMMMMMMMMSK                 ",
  "                ODSSSSSSSSSSSSSSDO     ODSSSSSSSSSSSSSSKO                ",
  "                 OOOOOOOOOOOOOOOO       OOOOOOOOOOOOOOOO                 ",
  "                OKSSSSSSSSSSSSSSK       KSSSSSSSSSSSSSSKO                ",
  "                OKDDDDDDDDDDDDDDK       KDDDDDDDDDDDDDDOO                ",
];

/**
 * The head alone, drawn separately rather than cropped: ROBOT is 73 cells wide, which is under a
 * quarter of a pixel per cell in a 16px favicon. Fewer tones, no inner panel border, and features
 * spaced so nothing merges when it is two pixels tall.
 */
export const MARK: readonly string[] = [
  "    L      L    ",
  "    M      M    ",
  "  OOOOOOOOOOOO  ",
  "  OMMMMMMMMMMO  ",
  "  OEEEEEEEEEEO  ",
  "  OELLLLLLLLEO  ",
  "OOOEMMMMMMMMEOOO",
  "OSOEMSSMMSSMEOSO",
  "OSOEMSSMMSSMEOSO",
  "OOOEMMMMMMMMEOOO",
  "  OEMMSSSSMMEO  ",
  "  ODDDDDDDDDDO  ",
  "  OOOOOOOOOOOO  ",
  "                ",
];

/**
 * Colours for the dashboard, every tone mixed from `--acc` so the mark follows the theme. Mixing
 * from the accent rather than naming greys is what keeps the tones separated in light mode, where
 * a fixed dark shade and the accent itself land at nearly the same luminance and the outline
 * vanishes into the face.
 */
export const ART_THEME: Readonly<Record<string, string>> = {
  O: "color-mix(in srgb, var(--acc) 40%, black)",
  K: "color-mix(in srgb, var(--acc) 51%, black)",
  D: "color-mix(in srgb, var(--acc) 58%, black)",
  S: "color-mix(in srgb, var(--acc) 71%, black)",
  E: "color-mix(in srgb, var(--acc) 84%, black)",
  M: "var(--acc)",
  L: "color-mix(in srgb, var(--acc) 52%, white)",
};

/** The same ramp as literal colours, for the site and the icon files, which have no custom properties. */
export const ART_PALETTE: Readonly<Record<string, string>> = {
  O: "#415b15",
  K: "#53751b",
  D: "#5f851f",
  S: "#73a325",
  E: "#89c12d",
  M: "#a3e635",
  L: "#d3f39f",
};

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
    /**
     * A tile behind the drawing, in cells of padding. An icon needs one so the art does not sit
     * on whatever the tab bar happens to be; an inline mark on a page does not.
     */
    tile?: { fill: string; pad?: number; radius?: number };
  } = {},
): string {
  const cell = opts.cell ?? 6;
  const cols = Math.max(...rows.map((r) => r.length));
  // A tile is square, so it takes the longer side plus padding and the art is centred in it.
  const pad = opts.tile ? (opts.tile.pad ?? 2) : 0;
  const side = Math.max(cols, rows.length) + pad * 2;
  const w = (opts.tile ? side : cols) * cell;
  const h = (opts.tile ? side : rows.length) * cell;
  const ox = opts.tile ? Math.round((side - cols) / 2) * cell : 0;
  const oy = opts.tile ? Math.round((side - rows.length) / 2) * cell : 0;
  let out = opts.tile
    ? `<rect width="${w}" height="${h}" rx="${opts.tile.radius ?? Math.round(w * 0.2)}" fill="${opts.tile.fill}"/>`
    : "";
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
      out += `<rect${cls ? ` class="${cls}"` : ""}${style ? ` style="${style}"` : ""} x="${ox + x * cell}" y="${oy + y * cell}" width="${run * cell}" height="${cell}" fill="${fill}"/>`;
      x += run;
    }
  });
  const cls = opts.className ? ` class="${opts.className}"` : "";
  const title = opts.title ? `<title>${opts.title}</title>` : "";
  return `<svg${cls} viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"${opts.title ? "" : ' aria-hidden="true"'}>${title}${out}</svg>`;
}
