import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swarm-settings-"));
const settings = join(dir, "settings.json");
const claudeJson = join(dir, ".claude.json");
process.env.CLAUDE_SETTINGS = settings;
process.env.CLAUDE_JSON = claudeJson;
const { install, status, uninstall } = await import("./install");

afterEach(() => {});

describe("install", () => {
  it("registers hooks and the swarm MCP server, and removes exactly those", () => {
    install();
    const s = status();
    expect(s.installed).toBe(true);
    expect(s.mcp).toBe(true);
    // MCP goes to ~/.claude.json (user scope) — settings.json's mcpServers is ignored by Claude Code
    const json = JSON.parse(readFileSync(settings, "utf8"));
    expect(json.mcpServers?.swarm).toBeUndefined();
    const cj = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(cj.mcpServers.swarm.type).toBe("stdio");
    expect(cj.mcpServers.swarm.command).toBeDefined();

    uninstall();
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.hooks).toBeUndefined();
    expect(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers?.swarm).toBeUndefined();
    expect(status().mcp).toBe(false);
  });
});
