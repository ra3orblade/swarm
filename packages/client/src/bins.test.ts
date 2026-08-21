import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { binCommand, resolveBin } from "./bins";

const tmp = () => mkdtempSync(join(tmpdir(), "swarm-bins-"));

describe("resolveBin", () => {
  test("dev layout: runs the sibling package's src/bin.ts with bun", () => {
    const argv = resolveBin("swarmd"); // from this file → packages/daemon/src/bin.ts exists
    expect(argv[0]).toBe("bun");
    expect(argv[1]).toEndWith("packages/daemon/src/bin.ts");
  });

  test("bundle layout: a sibling <name>.js next to the caller wins", () => {
    const dist = join(tmp(), "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "swarm-hook.js"), "");
    const from = pathToFileURL(join(dist, "swarm.js")).href;
    expect(resolveBin("swarm-hook", from)).toEqual(["bun", join(dist, "swarm-hook.js")]);
  });

  test("falls back to the bare name on PATH", () => {
    const from = pathToFileURL(join(tmp(), "nowhere", "x.js")).href;
    expect(resolveBin("swarm-mcp", from)).toEqual(["swarm-mcp"]);
  });

  test("binCommand quotes paths with spaces", () => {
    const dist = join(tmp(), "has space", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "swarm-hook.js"), "");
    const from = pathToFileURL(join(dist, "swarm.js")).href;
    expect(binCommand("swarm-hook", from)).toBe(`bun "${join(dist, "swarm-hook.js")}"`);
  });
});
