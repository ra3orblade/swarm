import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ART_PALETTE, ART_THEME, artSvg, HEAD, MARK, ROBOT, trimArt } from "./art";

describe("ROBOT", () => {
  test("every row is the same width — a short row shears the drawing", () => {
    expect(new Set(ROBOT.map((r) => r.length)).size).toBe(1);
  });

  test("uses only glyphs the palette defines", () => {
    const used = new Set(ROBOT.join("").split(""));
    used.delete(" ");
    expect([...used].sort()).toEqual(["D", "E", "K", "L", "M", "O", "S"]);
  });

  /**
   * The robot's silhouette is symmetric but its shading is not — it is lit from the top left, so
   * mirroring a row would move the highlights to the wrong side. This checks the shape alone.
   */
  test("the silhouette is mirrored about the vertical centre", () => {
    const shape = (r: string) => [...r].map((c) => (c === " " ? " " : "#")).join("");
    const off = ROBOT.map((_r, y) => y).filter((y) => {
      const s = shape(ROBOT[y] as string);
      return s !== [...s].reverse().join("");
    });
    expect(off).toEqual([]);
  });

  test("it is shaded, not flat — the lit side differs from the shaded side", () => {
    expect(ROBOT.some((r) => r !== [...r].reverse().join(""))).toBe(true);
  });

  test("HEAD is the top of the same drawing, not a second copy", () => {
    expect([...HEAD]).toEqual([...ROBOT.slice(0, HEAD.length)]);
    expect(HEAD.at(-1)?.trim()).not.toBe(""); // ends on the jaw, not on blank rows
  });

  test("MARK is its own drawing, not a crop that would turn to mush at 16px", () => {
    expect(MARK.length).toBeLessThan(ROBOT.length);
    expect((MARK[0] as string).length).toBeLessThan((HEAD[0] as string).length);
    expect(new Set(MARK.map((r) => r.length)).size).toBe(1);
    expect(MARK.every((r) => r === [...r].reverse().join(""))).toBe(true);
  });

  test("both drawings paint only glyphs the palettes define", () => {
    const used = new Set([...ROBOT, ...MARK].join("").split(""));
    used.delete(" ");
    expect([...used].every((g) => g in ART_THEME && g in ART_PALETTE)).toBe(true);
  });

  /**
   * The dashboard used to keep an *inline copy* of this drawing and its palette, because `app.js`
   * was a plain script that could not import from core. Three tests guarded that copy against
   * drift. The React dashboard imports `MARK` and `ART_THEME` and generates the SVG at render time
   * (`web/src/components/Mark.tsx`), so there is nothing left to drift — and this is what keeps it
   * that way. A pasted copy is how the splash and the header once wore different robots.
   */
  test("the dashboard keeps no pasted copy of the drawing", () => {
    const longestRow = [...ROBOT, ...MARK]
      .map((r) => r.trim())
      .reduce((a, b) => (b.length > a.length ? b : a));
    expect(longestRow.length).toBeGreaterThan(4);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && readFileSync(path, "utf8").includes(longestRow)) {
          offenders.push(entry.name);
        }
      }
    };
    walk(join(import.meta.dir, "../../web/src"));
    expect(offenders).toEqual([]);
  });
});

describe("trimArt", () => {
  test("removes blank rows and columns but keeps the shape", () => {
    expect(trimArt(["    ", " XX ", " X  ", "    "])).toEqual(["XX", "X "]);
  });

  test("a grid with no margin is returned unchanged", () => {
    expect(trimArt(["XX", "Xd"])).toEqual(["XX", "Xd"]);
  });

  /** A blank row inside the drawing is part of it — dropping it shortens the whole figure. */
  test("keeps a blank row in the middle and only trims the edges", () => {
    expect(trimArt(["  ", "XX", "  ", "XX", "  "])).toEqual(["XX", "  ", "XX"]);
  });

  test("the trimmed mark has no dead margin on either side", () => {
    const t = trimArt(MARK);
    expect(t.some((r) => r[0] !== " ")).toBe(true);
    expect(t.some((r) => r.at(-1) !== " ")).toBe(true);
  });
});

describe("artSvg", () => {
  test("emits one rect per painted cell and skips transparent ones", () => {
    const svg = artSvg(["Xd", " X"], { X: "#0f0", d: "#000" }, { cell: 2 });
    expect((svg.match(/<rect/g) ?? []).length).toBe(3);
    expect(svg).toContain('viewBox="0 0 4 4"');
  });

  test("a glyph with no colour paints nothing rather than a black square", () => {
    expect(artSvg(["z"], { X: "#0f0" }).match(/<rect/g)).toBeNull();
  });

  test("a titled icon is exposed to assistive tech; an untitled one is hidden", () => {
    expect(artSvg(["X"], { X: "#0f0" }, { title: "Swarm" })).toContain("<title>Swarm</title>");
    expect(artSvg(["X"], { X: "#0f0" })).toContain('aria-hidden="true"');
  });
});

describe("artSvg tile", () => {
  test("a tile squares off the viewBox and centres the art in it", () => {
    const svg = artSvg(["MM"], { M: "#0f0" }, { cell: 1, tile: { fill: "#000", pad: 1 } });
    expect(svg).toContain('viewBox="0 0 4 4"');
    expect(svg).toContain('<rect width="4" height="4"');
    expect(svg).toContain('fill="#000"');
  });

  test("without a tile the viewBox is the art itself and nothing is painted behind it", () => {
    const svg = artSvg(["MM"], { M: "#0f0" }, { cell: 1 });
    expect(svg).toContain('viewBox="0 0 2 1"');
    expect((svg.match(/<rect/g) ?? []).length).toBe(1);
  });
});

describe("artSvg classOf", () => {
  test("tags only the cells it selects, so one part can animate alone", () => {
    const svg = artSvg(
      ["XX", "XX"],
      { X: "#0f0" },
      { classOf: (_g: string, _x: number, y: number) => (y === 0 ? "blink" : undefined) },
    );
    // The tagged row merges into one tagged rect; the untagged row into one plain rect.
    expect((svg.match(/class="blink"/g) ?? []).length).toBe(1);
    expect((svg.match(/<rect/g) ?? []).length).toBe(2);
  });
});

describe("artSvg run-merging", () => {
  test("a run of one colour is a single wide rect, not one per cell", () => {
    const svg = artSvg(["XXXX"], { X: "#0f0" }, { cell: 2 });
    expect((svg.match(/<rect/g) ?? []).length).toBe(1);
    expect(svg).toContain('width="8"');
  });

  test("a colour change breaks the run", () => {
    expect((artSvg(["XXdd"], { X: "#0f0", d: "#000" }).match(/<rect/g) ?? []).length).toBe(2);
  });

  test("a transparent gap breaks the run", () => {
    expect((artSvg(["XX XX"], { X: "#0f0" }).match(/<rect/g) ?? []).length).toBe(2);
  });

  test("cells with different classes never merge", () => {
    const svg = artSvg(
      ["XX"],
      { X: "#0f0" },
      { classOf: (_g: string, x: number) => (x === 0 ? "a" : "b") },
    );
    expect((svg.match(/<rect/g) ?? []).length).toBe(2);
  });
});

describe("artSvg styleOf", () => {
  test("attaches a per-cell style and never merges cells that differ", () => {
    const svg = artSvg(["XX"], { X: "#0f0" }, { styleOf: (_g: string, x: number) => `--r:${x}` });
    expect((svg.match(/<rect/g) ?? []).length).toBe(2);
    expect(svg).toContain('style="--r:0"');
    expect(svg).toContain('style="--r:1"');
  });

  test("cells sharing a style still merge into one rect", () => {
    const svg = artSvg(["XXX"], { X: "#0f0" }, { styleOf: () => "--r:0" });
    expect((svg.match(/<rect/g) ?? []).length).toBe(1);
  });
});
