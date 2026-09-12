/**
 * Host or join a team from the app (M13.12).
 *
 * Everything a person used to do in a terminal — write settings, start `swarm-teamd`, point this
 * machine at it, register, pin the policy key — behind three calls the dashboard makes. The team
 * daemon itself stays source-available and separate: nothing here imports `packages/team`, it is
 * resolved as a command (a clone's source file, a sibling bundle, or `swarm-teamd` on PATH), so
 * the free bundle never carries FSL code.
 *
 * The hosted pid lives in `meta`, not in the process registry: that registry is keyed by project
 * and a team daemon belongs to the machine, not to a repo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { resolveBin } from "@swarm/client";
import {
  DEFAULT_TEAM_SETUP,
  hostedUrl,
  inviteLink,
  mintTeamSecret,
  parseInvite,
  parseTeamSetup,
  renderTeamSetup,
  type TeamAuthMode,
  type TeamSetup,
  withTeamUrl,
} from "@swarm/core";
import type { Store } from "./store";

const HOSTED_PID = "team_hosted_pid";

/** Is this pid still running? (`signal 0` asks without touching it.) */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The team daemon this machine started, if it is still up. A pid alone is not proof: after a
 * reboot the number can belong to anything, which would report "hosting", refuse every retry,
 * and — worse — aim `leaveTeam`'s SIGTERM at a stranger. The port must answer as a team daemon
 * too, and the pair is forgotten as soon as it does not.
 */
export function hostedPid(store: Store): number | null {
  const pid = Number(store.metaValue(HOSTED_PID) ?? 0);
  if (!alive(pid)) {
    if (pid) store.setMetaValue(HOSTED_PID, "");
    return null;
  }
  return pid;
}

/** `hostedPid`, confirmed by the port answering `/t1/health`. */
export async function hostedPidChecked(store: Store): Promise<number | null> {
  const pid = hostedPid(store);
  if (!pid) return null;
  if (await healthy(hostedUrl("127.0.0.1", readSetup(store.home).port))) return pid;
  store.setMetaValue(HOSTED_PID, "");
  return null;
}

/** First non-internal IPv4 — what a teammate on the same network can reach. */
export function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === "IPv4" && !n.internal) return n.address;
    }
  }
  return null;
}

function setupPath(home: string): string {
  return join(home, "team.toml");
}

export function readSetup(home: string): TeamSetup {
  const p = setupPath(home);
  return parseTeamSetup(existsSync(p) ? readFileSync(p, "utf8") : null);
}

function writeSetup(home: string, setup: TeamSetup): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(setupPath(home), renderTeamSetup(setup), { mode: 0o600 });
}

/** Point this machine's config at a team daemon (or clear it), and let the daemon see it now. */
export function setTeamUrl(store: Store, url: string | null): void {
  const path = join(store.home, "config.toml");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  mkdirSync(store.home, { recursive: true });
  writeFileSync(path, withTeamUrl(text, url));
  store.invalidateConfig();
}

async function healthy(url: string, ms = 500): Promise<boolean> {
  try {
    const r = await fetch(`${url}/t1/health`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Register this machine with the team daemon and store the credentials the forwarder uses.
 * `token` is the human's (a shared secret, or an OIDC token from `swarm login`); on a shared
 * secret deployment the machine forwards with that same secret.
 */
export async function registerMachine(
  store: Store,
  url: string,
  token: string | null,
): Promise<{ ok: true; mode: TeamAuthMode } | { ok: false; error: string }> {
  let mode: TeamAuthMode = "open";
  let policyPublicKey: string | undefined;
  try {
    const cfg = (await (
      await fetch(`${url}/t1/auth/config`, { signal: AbortSignal.timeout(4000) })
    ).json()) as { mode?: TeamAuthMode; policyPublicKey?: string };
    mode = cfg.mode ?? "open";
    policyPublicKey = cfg.policyPublicKey;
  } catch {
    return { ok: false, error: `no team daemon answering at ${url}` };
  }
  if (mode === "oidc" && !token)
    return {
      ok: false,
      error: "this team uses your identity provider — run `swarm login` in a terminal once",
    };
  const machine = store.machineIdentity();
  let reg: { token?: string; error?: string } = {};
  try {
    const res = await fetch(`${url}/t1/machines/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ id: machine.id, name: machine.name }),
      signal: AbortSignal.timeout(6000),
    });
    reg = (await res.json().catch(() => ({}))) as typeof reg;
    // a refused registration must not look like a join: on a shared-secret team the fallback
    // below would otherwise hand the forwarder the wrong secret and fail quietly forever
    if (!res.ok)
      return {
        ok: false,
        error: `registration refused (${res.status}): ${reg.error ?? "check the secret"}`,
      };
  } catch {
    return { ok: false, error: `registration failed: ${url} did not answer` };
  }
  const machineToken = reg.token ?? (mode === "token" ? token : null);
  if (mode !== "open" && !machineToken)
    return { ok: false, error: `registration refused: ${reg.error ?? "check the secret"}` };
  if (machineToken) store.setMetaValue("team_machine_token", machineToken);
  if (policyPublicKey) store.setMetaValue("team_policy_pubkey", policyPublicKey);
  return { ok: true, mode };
}

export interface HostInput {
  mode?: TeamAuthMode;
  port?: number;
  name?: string | null;
  /** Reuse an existing secret instead of minting one. */
  token?: string | null;
}

export interface HostResult {
  ok: true;
  url: string;
  invite: string;
  setup: TeamSetup;
  pid: number;
  /** Null when the machine has no LAN address — the invite is then loopback-only. */
  address: string | null;
}

/**
 * Write the settings, start `swarm-teamd` under the process registry, wait for it, point this
 * machine at it and register. Refuses rather than starting a second one.
 */
export async function hostTeam(
  store: Store,
  input: HostInput = {},
): Promise<HostResult | { ok: false; error: string }> {
  const existing = await hostedPidChecked(store);
  if (existing) return { ok: false, error: `already hosting a team (pid ${existing})` };
  const cur = readSetup(store.home);
  const mode = input.mode ?? cur.mode;
  const setup: TeamSetup = {
    ...DEFAULT_TEAM_SETUP,
    ...cur,
    mode,
    port: input.port ?? cur.port,
    name: input.name ?? cur.name,
    token: mode === "token" ? (input.token ?? cur.token ?? mintTeamSecret()) : null,
  };
  if (mode === "oidc" && (!setup.issuer || !setup.clientId))
    return {
      ok: false,
      error:
        "an identity-provider team needs an issuer and a client id — run `swarm-teamd setup` once",
    };
  writeSetup(store.home, setup);

  const loopback = hostedUrl("127.0.0.1", setup.port);
  if (await healthy(loopback))
    return { ok: false, error: `something is already listening on port ${setup.port}` };

  const [cmd, ...args] = resolveBin("swarm-teamd");
  const logDir = join(store.home, "logs");
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, "teamd.log");
  const proc = Bun.spawn([cmd as string, ...args], {
    cwd: store.home,
    env: { ...process.env, SWARM_HOME: store.home },
    stdout: Bun.file(log).writer() as never,
    stderr: Bun.file(log).writer() as never,
    stdin: "ignore",
  });
  proc.unref();

  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (await healthy(loopback)) break;
    if (proc.exitCode !== null)
      return {
        ok: false,
        error: `swarm-teamd exited (${proc.exitCode}) — see ${log}`,
      };
    await Bun.sleep(200);
  }
  if (!(await healthy(loopback))) {
    proc.kill();
    return {
      ok: false,
      error: `swarm-teamd (${cmd} ${args.join(" ")}) did not come up on ${setup.port} — see ${log}. The team daemon is source-available and ships separately; run it from a clone, or put swarm-teamd on PATH.`,
    };
  }

  store.setMetaValue(HOSTED_PID, String(proc.pid));
  setTeamUrl(store, loopback);
  const reg = await registerMachine(store, loopback, setup.token);
  if (!reg.ok) {
    // don't leave the machine pointed at a team it never joined: the forwarder would retry
    // unauthenticated forever and the next Host would be refused by the pid guard
    setTeamUrl(store, null);
    store.setMetaValue(HOSTED_PID, "");
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {
      /* it is already gone */
    }
    return reg;
  }
  const address = lanAddress();
  return {
    ok: true,
    url: loopback,
    invite: inviteLink(hostedUrl(address ?? "127.0.0.1", setup.port), setup.token),
    setup,
    pid: proc.pid,
    address,
  };
}

/** Join a team from an invite link, a URL, or a host name. */
export async function joinTeam(
  store: Store,
  input: { invite?: string; url?: string; token?: string | null },
): Promise<{ ok: true; url: string; mode: TeamAuthMode } | { ok: false; error: string }> {
  const parsed = input.invite ? parseInvite(input.invite) : null;
  const url = (parsed?.url ?? input.url ?? "").replace(/\/+$/, "");
  if (!url) return { ok: false, error: "paste an invite link or the team daemon's URL" };
  const token = input.token ?? parsed?.token ?? null;
  const reg = await registerMachine(store, url, token);
  if (!reg.ok) return reg;
  setTeamUrl(store, url);
  return { ok: true, url, mode: reg.mode };
}

/** Stop forwarding. A team daemon this machine hosts is left running unless `stopHosted`. */
export async function leaveTeam(
  store: Store,
  opts: { stopHosted?: boolean } = {},
): Promise<{ ok: true; stopped: boolean }> {
  setTeamUrl(store, null);
  store.setMetaValue("team_machine_token", "");
  let stopped = false;
  const pid = hostedPid(store);
  if (opts.stopHosted && pid) {
    // by pid, never by pattern — the same rule the product enforces on agents
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
    } catch {
      stopped = false;
    }
    store.setMetaValue(HOSTED_PID, "");
  }
  return { ok: true, stopped };
}

/** What the Team panel shows beyond the forwarder's own status. */
export function hostingStatus(store: Store): {
  hosting: boolean;
  pid: number | null;
  port: number | null;
  invite: string | null;
  mode: TeamAuthMode | null;
  address: string | null;
} {
  const pid = hostedPid(store);
  if (!pid)
    return { hosting: false, pid: null, port: null, invite: null, mode: null, address: null };
  const setup = readSetup(store.home);
  const address = lanAddress();
  return {
    hosting: true,
    pid,
    port: setup.port,
    invite: inviteLink(hostedUrl(address ?? "127.0.0.1", setup.port), setup.token),
    mode: setup.mode,
    address,
  };
}
