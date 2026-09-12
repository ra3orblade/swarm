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
const { install, installStatusline, setTeamUrl, status, uninstall, uninstallStatusline } =
  await import("./install");

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

describe("wake waiter (M13.4)", () => {
  it("arms one asyncRewake waiter, on Stop only, and removes it with the rest", () => {
    install();
    const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string; asyncRewake?: boolean; timeout?: number }> }>
    >;
    const waiters = (ev: string) =>
      (hooks[ev] ?? []).flatMap((g) => g.hooks).filter((h) => h.asyncRewake === true);
    // an idle period begins at Stop; SessionStart would spawn a second waiter per session
    expect(waiters("SessionStart")).toHaveLength(0);
    expect(waiters("Stop")).toHaveLength(1);
    expect(waiters("Stop")[0]?.command).toMatch(/ wait$/);
    expect(waiters("Stop")[0]?.timeout).toBe(3600);
    expect(waiters("PreToolUse")).toHaveLength(0);
    expect(status().coverage.complete).toBe(true);
    install(); // idempotent: still one waiter per event
    const again = JSON.parse(readFileSync(settings, "utf8")).hooks as typeof hooks;
    expect((again.Stop ?? []).flatMap((g) => g.hooks).filter((h) => h.asyncRewake)).toHaveLength(1);
    uninstall();
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks).toBeUndefined();
  });
});

describe("statusline (M12.2, `swarm install --statusline`)", () => {
  it("sets statusLine only when none is set, refreshes its own, and never replaces another", () => {
    const read = () => JSON.parse(readFileSync(settings, "utf8"));
    // start clean
    uninstallStatusline();
    expect(status().statusline).toBe("none");
    expect(installStatusline()).toBe("installed");
    expect(read().statusLine.type).toBe("command");
    expect(read().statusLine.command).toMatch(/statusline$/);
    expect(status().statusline).toBe("ours");
    expect(installStatusline()).toBe("refreshed");

    // uninstall removes exactly ours and counts it
    expect(uninstallStatusline()).toBe(true);
    expect(read().statusLine).toBeUndefined();
    expect(uninstallStatusline()).toBe(false);

    // someone else's status line is left alone, by install and by uninstall
    const s = read();
    s.statusLine = { type: "command", command: "~/.claude/statusline.sh" };
    writeFileSync(settings, JSON.stringify(s));
    expect(installStatusline()).toBe("kept");
    expect(status().statusline).toBe("other");
    install();
    uninstall();
    expect(read().statusLine.command).toBe("~/.claude/statusline.sh");
    delete s.statusLine;
    writeFileSync(settings, JSON.stringify(s));
  });
});

describe("setTeamUrl (M8.3f, `swarm install --config-url`)", () => {
  it("appends a [team] section to a fresh config and replaces the url on re-run", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-cfg-"));
    setTeamUrl(home, "https://swarm.example.internal");
    const path = join(home, "config.toml");
    expect(readFileSync(path, "utf8")).toContain('[team]\nurl = "https://swarm.example.internal"');
    setTeamUrl(home, "https://other.example.internal");
    const text = readFileSync(path, "utf8");
    expect(text).toContain('url = "https://other.example.internal"');
    expect(text).not.toContain("swarm.example.internal");
    expect(text.match(/\[team\]/g)?.length).toBe(1);
  });

  it("leaves other sections byte-for-byte and updates url inside an existing [team]", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-cfg2-"));
    const path = join(home, "config.toml");
    writeFileSync(
      path,
      `[daemon]\nport = 7878\n\n[team]\nurl = "https://old.internal"\ninterval = 9\n\n[rules]\nshared_tree = "deny"\n`,
    );
    setTeamUrl(home, "https://new.internal");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("port = 7878");
    expect(text).toContain('shared_tree = "deny"');
    expect(text).toContain('url = "https://new.internal"');
    expect(text).toContain("interval = 9");
    expect(text).not.toContain("old.internal");
  });
});
