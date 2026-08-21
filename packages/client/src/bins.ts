import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BinName = "swarm" | "swarmd" | "swarm-hook" | "swarm-mcp";

const SRC: Record<BinName, string> = {
  swarm: "cli",
  swarmd: "daemon",
  "swarm-hook": "hook",
  "swarm-mcp": "mcp",
};

/**
 * Resolve how to invoke one of Swarm's executables from wherever *this* code is running.
 * Three layouts, checked in order:
 *  1. clone / dev — `packages/<pkg>/src/bin.ts` exists relative to this file → `bun <that file>`
 *  2. published bundle (`@ra3orblade/swarm`) — a sibling `<name>.js` next to the running bundle
 *     → `bun <abs path>` (absolute, so hooks/MCP configs keep working regardless of PATH; covers
 *     `npx` as well as a global install)
 *  3. otherwise assume `<name>` is on PATH.
 * `from` is the caller's `import.meta.url`; it defaults to this module's, which is correct for the
 * dev layout and — because the bundle inlines this module — also for the bundled layout.
 */
export function resolveBin(name: BinName, from: string = import.meta.url): string[] {
  const here = dirname(fileURLToPath(from));
  const candidates = [
    // dev: packages/<this>/src → packages/<pkg>/src/bin.ts
    resolve(here, `../../${SRC[name]}/src/bin.ts`),
    // bundle: npm/dist/<name>.js (siblings)
    resolve(here, `${name}.js`),
  ];
  for (const c of candidates) if (existsSync(c)) return ["bun", c];
  return [name];
}

/** Shell form of {@link resolveBin}, for hook command strings. */
export function binCommand(name: BinName, from?: string): string {
  return resolveBin(name, from)
    .map((p) => (/[\s"']/.test(p) ? JSON.stringify(p) : p))
    .join(" ");
}
