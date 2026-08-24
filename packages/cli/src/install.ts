import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { binCommand, resolveBin } from "@swarm/client";
import { HOOK_EVENTS, type HookCoverage, hookCoverage, hookIsOurs } from "@swarm/core";

const isOurs = hookIsOurs;
const settingsPath = () =>
  process.env.CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
/** User-scope MCP servers live in ~/.claude.json (`claude mcp add -s user`), NOT in settings.json —
 *  Claude Code ignores `mcpServers` there. Swarm registered in the wrong file until 0.4.2. */
const claudeJsonPath = () => process.env.CLAUDE_JSON ?? join(homedir(), ".claude.json");

function loadClaudeJson(): Record<string, unknown> {
  const p = claudeJsonPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function saveClaudeJson(c: Record<string, unknown>) {
  writeFileSync(claudeJsonPath(), `${JSON.stringify(c, null, 2)}\n`);
}
function registerMcp(): void {
  const c = loadClaudeJson();
  const mcp = (c.mcpServers as Record<string, unknown> | undefined) ?? {};
  mcp.swarm = { type: "stdio", ...mcpServerConfig() };
  c.mcpServers = mcp;
  saveClaudeJson(c);
}
function unregisterMcp(): boolean {
  const c = loadClaudeJson();
  const mcp = (c.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (!mcp.swarm) return false;
  delete mcp.swarm;
  if (Object.keys(mcp).length) c.mcpServers = mcp;
  else delete c.mcpServers;
  saveClaudeJson(c);
  return true;
}
function mcpRegistered(): boolean {
  const c = loadClaudeJson();
  return Boolean((c.mcpServers as Record<string, unknown> | undefined)?.swarm);
}

// ---------- M7.10: the same MCP server for other agent CLIs that host MCP (Codex, Gemini CLI).
// Only touched when the CLI's config dir already exists — we never create another tool's config.
const codexConfigPath = () => process.env.CODEX_CONFIG ?? join(homedir(), ".codex", "config.toml");
const geminiSettingsPath = () =>
  process.env.GEMINI_SETTINGS ?? join(homedir(), ".gemini", "settings.json");

/** `[mcp_servers.swarm]` block for Codex's TOML config; replaced in place, never duplicated. */
function codexBlock(): string {
  const { command, args } = mcpServerConfig();
  return `[mcp_servers.swarm]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`;
}
const CODEX_BLOCK_RE = /\[mcp_servers\.swarm\]\n(?:(?!\[)[^\n]*\n?)*/;
function registerCodex(): boolean {
  const p = codexConfigPath();
  if (!existsSync(join(p, ".."))) return false;
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  const next = CODEX_BLOCK_RE.test(cur)
    ? cur.replace(CODEX_BLOCK_RE, codexBlock())
    : `${cur.trimEnd()}${cur.trim() ? "\n\n" : ""}${codexBlock()}`;
  if (next !== cur) writeFileSync(p, next);
  return true;
}
function unregisterCodex(): boolean {
  const p = codexConfigPath();
  if (!existsSync(p)) return false;
  const cur = readFileSync(p, "utf8");
  if (!CODEX_BLOCK_RE.test(cur)) return false;
  writeFileSync(
    p,
    cur
      .replace(CODEX_BLOCK_RE, "")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()
      .concat("\n"),
  );
  return true;
}
function registerGemini(): boolean {
  const p = geminiSettingsPath();
  if (!existsSync(join(p, ".."))) return false;
  let c: Record<string, unknown> = {};
  try {
    c = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return false; // someone else's broken JSON is not ours to rewrite
  }
  const mcp = (c.mcpServers as Record<string, unknown> | undefined) ?? {};
  mcp.swarm = mcpServerConfig();
  c.mcpServers = mcp;
  writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`);
  return true;
}
function unregisterGemini(): boolean {
  const p = geminiSettingsPath();
  if (!existsSync(p)) return false;
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const mcp = (c.mcpServers as Record<string, unknown> | undefined) ?? {};
    if (!mcp.swarm) return false;
    delete mcp.swarm;
    if (Object.keys(mcp).length) c.mcpServers = mcp;
    else delete c.mcpServers;
    writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
/** Which other agent CLIs got the MCP server. */
export function registerOtherAgents(): string[] {
  const out: string[] = [];
  if (registerCodex()) out.push("codex");
  if (registerGemini()) out.push("gemini");
  return out;
}
export function unregisterOtherAgents(): string[] {
  const out: string[] = [];
  if (unregisterCodex()) out.push("codex");
  if (unregisterGemini()) out.push("gemini");
  return out;
}

/** The command Claude Code should run for each hook event — portable across clone, global
 *  install and `npx` (see `resolveBin` in @swarm/client). */
const hookCommand = (event: string) => `${binCommand("swarm-hook")} ${event}`;
const shimPath = () => resolveBin("swarm-hook").at(-1) as string;

/** MCP server registration (command + args) — same resolution as the hook. */
function mcpServerConfig(): { command: string; args: string[] } {
  const [command, ...args] = resolveBin("swarm-mcp");
  return { command: command as string, args };
}

type Hooks = Record<
  string,
  Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>
>;

function load(): Record<string, unknown> {
  const p = settingsPath();
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
}
function save(s: Record<string, unknown>) {
  writeFileSync(settingsPath(), `${JSON.stringify(s, null, 2)}\n`);
}

export function install(): string[] {
  const s = load();
  const hooks = ((s.hooks as Hooks | undefined) ?? {}) as Hooks;
  const added: string[] = [];
  for (const ev of HOOK_EVENTS) {
    const list = hooks[ev] ?? [];
    const clean = list
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    clean.push({
      hooks: [{ type: "command", command: hookCommand(ev), timeout: 5 }],
    });
    hooks[ev] = clean;
    added.push(ev);
  }
  s.hooks = hooks;
  // A stale `mcpServers.swarm` in settings.json (pre-0.4.2) does nothing; clean it up.
  const stale = (s.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (stale.swarm) {
    delete stale.swarm;
    if (Object.keys(stale).length) s.mcpServers = stale;
    else delete s.mcpServers;
  }
  save(s);
  // register the MCP server (user scope, ~/.claude.json) so agents get the swarm_* tools
  registerMcp();
  registerOtherAgents();
  return added;
}

export function uninstall(): number {
  const s = load();
  const hooks = (s.hooks as Hooks | undefined) ?? {};
  let removed = 0;
  for (const ev of Object.keys(hooks)) {
    const before = hooks[ev] ?? [];
    const after = before
      .map((g) => ({
        ...g,
        hooks: g.hooks.filter((h) => {
          if (isOurs(h)) {
            removed++;
            return false;
          }
          return true;
        }),
      }))
      .filter((g) => g.hooks.length);
    if (after.length) hooks[ev] = after;
    else delete hooks[ev];
  }
  if (Object.keys(hooks).length) s.hooks = hooks;
  else delete s.hooks;
  const mcp = (s.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (mcp.swarm) delete mcp.swarm;
  if (Object.keys(mcp).length) s.mcpServers = mcp;
  else delete s.mcpServers;
  save(s);
  if (unregisterMcp()) removed++;
  removed += unregisterOtherAgents().length;
  return removed;
}

export function status(): {
  installed: boolean;
  /** Per-event hook coverage (M8.1b): which events lost their entry or got a short timeout. */
  coverage: HookCoverage;
  mcp: boolean;
  path: string;
  shim: string;
  otherAgents: string[];
} {
  const s = load();
  const hooks = (s.hooks as Hooks | undefined) ?? {};
  const installed = Object.values(hooks).some((l) => l.some((g) => g.hooks.some(isOurs)));
  const otherAgents: string[] = [];
  const cp = codexConfigPath();
  if (existsSync(cp) && CODEX_BLOCK_RE.test(readFileSync(cp, "utf8"))) otherAgents.push("codex");
  const gp = geminiSettingsPath();
  try {
    if (existsSync(gp) && JSON.parse(readFileSync(gp, "utf8")).mcpServers?.swarm)
      otherAgents.push("gemini");
  } catch {}
  return {
    installed,
    coverage: hookCoverage(s),
    mcp: mcpRegistered(),
    path: settingsPath(),
    shim: shimPath(),
    otherAgents,
  };
}

/**
 * M8.3f / fleet install: write `[team] url = …` into `<home>/config.toml`, replacing an existing
 * `[team]` url line or appending the section. Everything else in the file is left byte-for-byte.
 */
export function setTeamUrl(home: string, url: string): void {
  const path = join(home, "config.toml");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  let out: string;
  const section = text.match(/(^|\n)\[team\]([\s\S]*?)(?=\n\[|$)/);
  if (section) {
    const body = section[2] ?? "";
    const newBody = /^\s*url\s*=/m.test(body)
      ? body.replace(/^\s*url\s*=.*$/m, `url = "${url}"`)
      : `\nurl = "${url}"${body}`;
    out = text.replace(section[0], `${section[1]}[team]${newBody}`);
  } else {
    out = `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n[team]\nurl = "${url}"\n`;
  }
  writeFileSync(path, out);
}
