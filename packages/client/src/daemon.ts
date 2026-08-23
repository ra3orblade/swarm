import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBin } from "./bins";

export function swarmHome(): string {
  return process.env.SWARM_HOME ?? join(homedir(), ".swarm");
}
export const DEFAULT_PORT = Number(process.env.SWARM_PORT ?? 7777);
const infoFile = () => join(swarmHome(), "daemon.json");

export interface DaemonInfo {
  port: number;
  pid: number;
  version: string;
  startedAt: string;
  url: string;
}

export function readDaemonInfo(): DaemonInfo | null {
  const file = infoFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

/** Called by the daemon on boot. */
export function writeDaemonInfo(info: Omit<DaemonInfo, "url">): DaemonInfo {
  const home = swarmHome();
  mkdirSync(home, { recursive: true });
  const full = { ...info, url: `http://127.0.0.1:${info.port}` };
  writeFileSync(join(home, "daemon.json"), `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

// ---------- M8.2b: daemon token
// One secret per Swarm home, created by the daemon on first start (mode 0600). Every client on the
// machine reads it and sends `Authorization: Bearer …`; the daemon requires it for non-loopback
// callers always, and for loopback callers when `[daemon] auth = "required"`.
const tokenFile = (home = swarmHome()) => join(home, "token");
export function readToken(home = swarmHome()): string | null {
  try {
    const t = readFileSync(tokenFile(home), "utf8").trim();
    return /^[a-f0-9]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}
/** Create the token if missing; returns it. Daemon-side. */
export function ensureToken(home = swarmHome()): string {
  const cur = readToken(home);
  if (cur) return cur;
  mkdirSync(home, { recursive: true });
  const t = randomBytes(32).toString("hex");
  writeFileSync(tokenFile(home), `${t}\n`, { mode: 0o600 });
  return t;
}
export function authHeaders(home = swarmHome()): Record<string, string> {
  const t = readToken(home);
  return t ? { authorization: `Bearer ${t}` } : {};
}
/** `fetch` that carries the daemon token. Drop-in: `import { authedFetch as fetch }`. */
export const authedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const h = new Headers(init?.headers);
  const t = readToken();
  if (t && !h.has("authorization")) h.set("authorization", `Bearer ${t}`);
  return fetch(input, { ...init, headers: h });
};

export function clearDaemonInfo() {
  rmSync(infoFile(), { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the daemon entrypoint (clone → bundle → PATH). Returns argv for spawning. */
export function daemonCommand(): string[] {
  return resolveBin("swarmd");
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

  // Re-resolve each poll: the daemon may pick a free port when its preferred one is taken and
  // records the real URL in daemon.json, so the target can change once it boots.
  for (let i = 0; i < 50; i++) {
    const target = resolveBaseUrl(opts.baseUrl);
    if (await pingHealth(target, 300)) return target;
    await Bun.sleep(100);
  }
  throw new Error("swarmd did not become healthy within 5s");
}
