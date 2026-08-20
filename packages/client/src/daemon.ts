import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SWARM_HOME = process.env.SWARM_HOME ?? join(homedir(), ".swarm");
export const DEFAULT_PORT = Number(process.env.SWARM_PORT ?? 7777);
const INFO_FILE = join(SWARM_HOME, "daemon.json");

export interface DaemonInfo {
  port: number;
  pid: number;
  version: string;
  startedAt: string;
  url: string;
}

export function readDaemonInfo(): DaemonInfo | null {
  if (!existsSync(INFO_FILE)) return null;
  try {
    return JSON.parse(readFileSync(INFO_FILE, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

/** Called by the daemon on boot. */
export function writeDaemonInfo(info: Omit<DaemonInfo, "url">): DaemonInfo {
  mkdirSync(SWARM_HOME, { recursive: true });
  const full = { ...info, url: `http://127.0.0.1:${info.port}` };
  writeFileSync(INFO_FILE, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

export function clearDaemonInfo() {
  rmSync(INFO_FILE, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the daemon entrypoint. Prefer `swarmd` on PATH (global install); fall back to the
 *  source bin relative to this file (clone / dev). Returns argv for spawning. */
export function daemonCommand(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/client/src -> packages/daemon/src/bin.ts
  const srcBin = resolve(here, "../../daemon/src/bin.ts");
  if (existsSync(srcBin)) return ["bun", srcBin];
  return ["swarmd"];
}

export interface DaemonClientOptions {
  baseUrl?: string;
  autoStart?: boolean;
}

/** Base URL from (in order): explicit, SWARM_URL, daemon.json, default port. */
export function resolveBaseUrl(explicit?: string): string {
  const raw =
    explicit ??
    process.env.SWARM_URL ??
    readDaemonInfo()?.url ??
    `http://127.0.0.1:${DEFAULT_PORT}`;
  return raw.replace(/\/$/, "");
}

async function pingHealth(baseUrl: string, timeoutMs = 800): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure a daemon is reachable, starting one (detached) if not. Returns the base URL.
 * Only interactive clients (CLI, `ui`) should auto-start — the hook shim must never block on this.
 */
export async function ensureDaemon(
  opts: { baseUrl?: string; quiet?: boolean } = {},
): Promise<string> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  if (await pingHealth(baseUrl)) return baseUrl;

  const info = readDaemonInfo();
  if (info && alive(info.pid) && (await pingHealth(info.url))) return info.url;

  // spawn detached
  const [cmd, ...args] = daemonCommand();
  if (!cmd) throw new Error("could not resolve the daemon command");
  if (!opts.quiet) process.stderr.write("starting swarmd…\n");
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: { ...process.env },
  });
  proc.unref();

  const target = resolveBaseUrl(opts.baseUrl);
  for (let i = 0; i < 50; i++) {
    if (await pingHealth(target, 300)) return target;
    await Bun.sleep(100);
  }
  throw new Error("swarmd did not become healthy within 5s");
}
