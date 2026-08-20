import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_EVENTS } from "@harness/core";

const MARK = "harness-hook"; // prod bin name
const isOurs = (h: { command: string }) =>
  h.command.includes(MARK) || h.command.includes("/packages/hook/src/bin.ts");
const settingsPath = () =>
  process.env.CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
const shimPath = () => resolve(dirname(fileURLToPath(import.meta.url)), "../../hook/src/bin.ts");

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
      hooks: [{ type: "command", command: `bun ${shimPath()} ${ev}`, timeout: 5 }],
    });
    hooks[ev] = clean;
    added.push(ev);
  }
  s.hooks = hooks;
  save(s);
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
  save(s);
  return removed;
}

export function status(): { installed: boolean; path: string; shim: string } {
  const hooks = (load().hooks as Hooks | undefined) ?? {};
  const installed = Object.values(hooks).some((l) => l.some((g) => g.hooks.some(isOurs)));
  return { installed, path: settingsPath(), shim: shimPath() };
}
