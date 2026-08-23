import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swarm-settings-"));
const settings = join(dir, "settings.json");
const claudeJson = join(dir, ".claude.json");
process.env.CLAUDE_SETTINGS = settings;
process.env.CLAUDE_JSON = claudeJson;
// M7.10: other agent CLIs that host MCP — only touched when their config dir exists
const codexDir = join(dir, ".codex");
const geminiDir = join(dir, ".gemini");
mkdirSync(codexDir);
mkdirSync(geminiDir);
process.env.CODEX_CONFIG = join(codexDir, "config.toml");
process.env.GEMINI_SETTINGS = join(geminiDir, "settings.json");
writeFileSync(
  process.env.CODEX_CONFIG,
  'model = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "x"\n',
);
writeFileSync(
  process.env.GEMINI_SETTINGS,
  '{"theme":"dark","mcpServers":{"other":{"command":"y"}}}\n',
);
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

    // Codex + Gemini got the same server, without disturbing what was there
    expect(s.otherAgents).toEqual(["codex", "gemini"]);
    const toml = readFileSync(process.env.CODEX_CONFIG as string, "utf8");
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml.match(/\[mcp_servers\.swarm\]/g)?.length).toBe(1);
    install(); // idempotent
    expect(
      readFileSync(process.env.CODEX_CONFIG as string, "utf8").match(/\[mcp_servers\.swarm\]/g)
        ?.length,
    ).toBe(1);
    const gem = JSON.parse(readFileSync(process.env.GEMINI_SETTINGS as string, "utf8"));
    expect(gem.theme).toBe("dark");
    expect(gem.mcpServers.other.command).toBe("y");
    expect(gem.mcpServers.swarm.command).toBeDefined();

    uninstall();
    expect(readFileSync(process.env.CODEX_CONFIG as string, "utf8")).toBe(
      'model = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    expect(
      JSON.parse(readFileSync(process.env.GEMINI_SETTINGS as string, "utf8")).mcpServers,
    ).toEqual({ other: { command: "y" } });
    expect(status().otherAgents).toEqual([]);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.hooks).toBeUndefined();
    expect(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers?.swarm).toBeUndefined();
    expect(status().mcp).toBe(false);
  });
});
