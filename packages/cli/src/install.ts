import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { binCommand, resolveBin } from "@swarm/client";
import {
  HOOK_EVENTS,
  type HookCoverage,
  hookCoverage,
  hookIsOurs,
  statuslineIsOurs,
} from "@swarm/core";

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
// ---------- M12.4: the rules on Codex and Gemini CLI, through each one's own pre-tool hook.
// Cursor needs nothing here: it runs the Claude Code hooks in ~/.claude/settings.json itself.
const codexHooksPath = () => process.env.CODEX_HOOKS ?? join(codexConfigPath(), "..", "hooks.json");

type HookGroup = { matcher?: string; hooks: Array<Record<string, unknown>> };
const oursIn = (g: HookGroup) =>
  g.hooks.some((h) => typeof h.command === "string" && isOurs(h as { command: string }));

/** Read a JSON settings file we share with another tool; null when it is not ours to rewrite. */
function readShared(p: string): Record<string, unknown> | null {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return null; // someone else's broken JSON is not ours to rewrite
  }
}

/** Replace our group under `event` in a `{hooks: {Event: [group…]}}` file, keeping everyone else's. */
function putHook(p: string, event: string, group: HookGroup | null): boolean {
  const c = readShared(p);
  if (!c) return false;
  const hooks = (c.hooks as Record<string, HookGroup[]> | undefined) ?? {};
  const kept = (hooks[event] ?? []).filter((g) => !oursIn(g));
  const had = kept.length !== (hooks[event] ?? []).length;
  if (group) kept.push(group);
  else if (!had) return false;
  if (kept.length) hooks[event] = kept;
  else delete hooks[event];
  if (Object.keys(hooks).length) c.hooks = hooks;
  else delete c.hooks;
  writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`);
  return true;
}

/** Codex `PreToolUse` in ~/.codex/hooks.json: Bash and apply_patch (Codex asks the user to trust it once, in /hooks). */
function guardCodex(on: boolean): boolean {
  const p = codexHooksPath();
  if (!existsSync(join(p, ".."))) return false;
  return putHook(
    p,
    "PreToolUse",
    on
      ? {
          matcher: "Bash|apply_patch",
          hooks: [{ type: "command", command: hookCommand("PreToolUse"), timeout: 5 }],
        }
      : null,
  );
}

/** Gemini CLI `BeforeTool` in ~/.gemini/settings.json: shell, writes and reads (timeout in ms). */
function guardGemini(on: boolean): boolean {
  const p = geminiSettingsPath();
  if (!existsSync(join(p, ".."))) return false;
  return putHook(
    p,
    "BeforeTool",
    on
      ? {
          matcher: "run_shell_command|write_file|replace|read_file",
          hooks: [
            { name: "swarm", type: "command", command: hookCommand("BeforeTool"), timeout: 5000 },
          ],
        }
      : null,
  );
}

/** Which rule hooks other agents carry, from their files (for `status` / `doctor`). */
function guardedAgents(): string[] {
  const out: string[] = [];
  const has = (p: string, event: string) => {
    const c = readShared(p);
    const groups = (c?.hooks as Record<string, HookGroup[]> | undefined)?.[event] ?? [];
    return groups.some(oursIn);
  };
  if (existsSync(codexHooksPath()) && has(codexHooksPath(), "PreToolUse")) out.push("codex");
  if (existsSync(geminiSettingsPath()) && has(geminiSettingsPath(), "BeforeTool"))
    out.push("gemini");
  return out;
}

/** Which other agent CLIs got the MCP server (and, M12.4, the rules hook). */
export function registerOtherAgents(): string[] {
  const out: string[] = [];
  if (registerCodex()) out.push("codex");
  if (registerGemini()) out.push("gemini");
  guardCodex(true);
  guardGemini(true);
  return out;
}
export function unregisterOtherAgents(): string[] {
  const out: string[] = [];
  if (unregisterCodex()) out.push("codex");
  if (unregisterGemini()) out.push("gemini");
  guardCodex(false);
  guardGemini(false);
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
  Array<{
    matcher?: string;
    hooks: Array<{ type: string; command: string; timeout?: number; asyncRewake?: boolean }>;
  }>
>;

/**
 * M13.4: the event that arms the background waiter. `Stop` only — that is where an idle period
 * actually begins; arming on `SessionStart` as well spawned a second waiter process per session
 * for a session that was about to be busy anyway.
 */
const WAKE_EVENTS = new Set(["Stop"]);

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
      // M13.1: Stop may wait for the repair loop's gates; everything else answers in < 1 s.
      hooks: [
        {
          type: "command",
          command: hookCommand(ev),
          // M13.2: a PermissionRequest may wait for the dashboard's answer (≤ 120 s)
          timeout: ev === "Stop" ? 330 : ev === "PermissionRequest" ? 150 : 5,
        },
        // M13.4: a background waiter that exits 2 with the text when a message lands, waking the
        // idle session; Claude Code cancels it at `timeout`, so it gives up on its own before.
        ...(WAKE_EVENTS.has(ev)
          ? [{ type: "command", command: hookCommand("wait"), timeout: 3600, asyncRewake: true }]
          : []),
      ],
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

/**
 * M12.2: `statusLine` in settings.json. Written only when none is set (or the one set is ours —
 * re-install refreshes the path); someone else's statusline is never replaced. Returns what
 * happened so the CLI can say it.
 */
export type StatuslineInstall = "installed" | "refreshed" | "kept";
export function installStatusline(): StatuslineInstall {
  const s = load();
  const cur = s.statusLine;
  if (cur && !statuslineIsOurs(cur)) return "kept";
  s.statusLine = { type: "command", command: `${binCommand("swarm-hook")} statusline` };
  save(s);
  return cur ? "refreshed" : "installed";
}
/** Remove our statusLine entry; false when it was not ours (or absent). */
export function uninstallStatusline(): boolean {
  const s = load();
  if (!statuslineIsOurs(s.statusLine)) return false;
  delete s.statusLine;
  save(s);
  return true;
}
export type StatuslineStatus = "ours" | "other" | "none";
function statuslineStatus(s: Record<string, unknown>): StatuslineStatus {
  if (!s.statusLine) return "none";
  return statuslineIsOurs(s.statusLine) ? "ours" : "other";
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
  if (statuslineIsOurs(s.statusLine)) {
    delete s.statusLine;
    removed++;
  }
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
  /** M12.2: whose `statusLine` is set — ours, someone else's, or none. */
  statusline: StatuslineStatus;
  /** M12.4: other agents whose own pre-tool hook runs the rules. */
  guarded: string[];
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
    statusline: statuslineStatus(s),
    guarded: guardedAgents(),
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
