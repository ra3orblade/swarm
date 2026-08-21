import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const settings = join(mkdtempSync(join(tmpdir(), "swarm-settings-")), "settings.json");
process.env.CLAUDE_SETTINGS = settings;
const { install, status, uninstall } = await import("./install");

afterEach(() => {});

describe("install", () => {
  it("registers hooks and the swarm MCP server, and removes exactly those", () => {
    install();
    const s = status();
    expect(s.installed).toBe(true);
    expect(s.mcp).toBe(true);
    const json = JSON.parse(readFileSync(settings, "utf8"));
    expect(json.mcpServers.swarm.type).toBe("stdio");
    expect(json.mcpServers.swarm.command).toBeDefined();

    uninstall();
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.mcpServers?.swarm).toBeUndefined();
    expect(after.hooks).toBeUndefined();
  });
});
