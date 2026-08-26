import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { artSvg, ROBOT, ROBOT_HEAD, trimArt } from "./art";

describe("ROBOT", () => {
  test("every row is the same width — a short row shears the drawing", () => {
    expect(new Set(ROBOT.map((r) => r.length)).size).toBe(1);
  });

  test("uses only glyphs the palette defines", () => {
    const used = new Set(ROBOT.join("").split(""));
    used.delete(" ");
    expect([...used].sort()).toEqual(["X", "d", "g"]);
  });

  test("the head is the top of the same drawing, not a second copy", () => {
    expect(ROBOT_HEAD).toEqual(ROBOT.slice(0, 13));
  });

  /**
   * app.js cannot import from core — it is a plain script served to the browser — so it keeps an
   * inline copy. This is the guard that the copy still matches; without it the dashboard and the
   * site would drift apart the next time either is edited.
   */
  test("the dashboard's inline copy is identical to this one", () => {
    const app = readFileSync(join(import.meta.dir, "../../web/public/app.js"), "utf8");
    const start = app.indexOf("idle: () =>");
    expect(start).toBeGreaterThan(-1);
    const block = app.slice(start, app.indexOf("],", start));
    const rows = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(rows).toEqual([...ROBOT]);
  });
});

describe("trimArt", () => {
  test("removes blank rows and columns but keeps the shape", () => {
    expect(trimArt(["    ", " XX ", " X  ", "    "])).toEqual(["XX", "X "]);
  });

  test("a grid with no margin is returned unchanged", () => {
    expect(trimArt(["XX", "Xd"])).toEqual(["XX", "Xd"]);
  });

  test("the trimmed head has no dead margin on either side", () => {
    const t = trimArt(ROBOT_HEAD);
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
