import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { binCommand, resolveBin } from "@swarm/client";
import { HOOK_EVENTS } from "@swarm/core";

const MARK = "swarm-hook"; // prod bin name
const isOurs = (h: { command: string }) =>
  h.command.includes(MARK) || h.command.includes("/packages/hook/src/bin.ts");
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
  return removed;
}

export function status(): { installed: boolean; mcp: boolean; path: string; shim: string } {
  const s = load();
  const hooks = (s.hooks as Hooks | undefined) ?? {};
  const installed = Object.values(hooks).some((l) => l.some((g) => g.hooks.some(isOurs)));
  return { installed, mcp: mcpRegistered(), path: settingsPath(), shim: shimPath() };
}
