/**
 * Sandboxed runs (M12.6, OQ-21): what `swarm run --sandbox` hands Anthropic's `sandbox-runtime`.
 *
 * `srt` wraps the spawned `claude -p` in the OS sandbox (macOS Seatbelt, Linux bubblewrap) and
 * routes its traffic through a filtering proxy. Everything below is the policy Swarm writes for one
 * run; the enforcement is `srt`'s. It is an optional dependency: a run that asks for the sandbox
 * when `srt` is not installed is refused with {@link SANDBOX_INSTALL}, never started unfenced.
 *
 * Reads stay open (an agent reads the whole machine's toolchain), apart from a few credential
 * stores. Writes are the claimed worktree, the repository's git directory (a commit in a worktree
 * writes objects and refs there), Claude Code's own state and the temp dirs: Claude Code's Bash
 * tool keeps its cwd file at `/tmp/claude-<hex>-cwd`, outside any per-user directory, so `/tmp` is
 * writable as a whole (a run with `/tmp` read-only fails every Bash call).
 * Egress is the model API plus `[sandbox] allowed_domains`, seeded from the hosts the project's
 * agents already reached (the Security view, M9.9) unless `seed = false`. Loopback stays reachable:
 * the hooks talk to the daemon on it, and a sandbox that blocks localhost breaks every test suite
 * with a server in it.
 *
 * Verified against `@anthropic-ai/sandbox-runtime` 0.0.78 on macOS: Claude Code runs under it with
 * exactly this shape, and a blocked call reaches the transcript as `operation not permitted`
 * (filesystem) or a 403 from the proxy (network). {@link sandboxViolation} reads those.
 */

export const SANDBOX_PACKAGE = "@anthropic-ai/sandbox-runtime";
export const SANDBOX_INSTALL = `npm install -g ${SANDBOX_PACKAGE}`;

/** What Claude Code itself needs to reach: the model API and the sign-in refresh. */
export const AGENT_DOMAINS = ["api.anthropic.com", "console.anthropic.com", "claude.ai"];

/** Credential stores no sandboxed run may read. Paths under `~`. */
export const SANDBOX_DENY_READ = ["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc"];

/** `srt --settings` file shape (the subset Swarm writes). */
export interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
}

export interface SandboxPolicyInput {
  /** The claimed worktree the agent runs in. */
  worktree: string;
  /** `git rev-parse --git-common-dir`, absolute; null when it could not be read. */
  gitCommonDir: string | null;
  home: string;
  /** `os.tmpdir()`. */
  tmpdir: string;
  /** `[sandbox] allowed_domains`. */
  allowed: string[];
  /** Remote hosts seen in the project (already filtered to non-loopback), when seeding is on. */
  seeded: string[];
}

/** A domain as `srt` accepts it: a hostname or `*.` wildcard, optional `:port`. */
export function validDomain(d: string): boolean {
  return /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(
    d,
  );
}

/** The egress allow-list for one run, deduped and sorted after the agent's own domains. */
export function sandboxDomains(allowed: string[], seeded: string[]): string[] {
  const extra = new Set<string>();
  for (const d of [...allowed, ...seeded]) {
    const v = d.trim().toLowerCase();
    if (v && validDomain(v) && !AGENT_DOMAINS.includes(v)) extra.add(v);
  }
  return [...AGENT_DOMAINS, ...[...extra].sort()];
}

/** The `srt` settings for one run. Pure: every path it needs is passed in. */
export function sandboxSettings(p: SandboxPolicyInput): SrtSettings {
  const home = p.home.replace(/\/+$/, "");
  // macOS resolves /tmp to /private/tmp; Seatbelt matches the real path
  const tmp = new Set([p.tmpdir.replace(/\/+$/, ""), "/tmp", "/private/tmp"]);
  const write = [
    p.worktree,
    ...(p.gitCommonDir ? [p.gitCommonDir] : []),
    `${home}/.claude`,
    `${home}/.claude.json`,
    `${home}/.claude.json.lock`,
    `${home}/.claude.json.backup`,
    ...tmp,
  ];
  return {
    network: {
      allowedDomains: sandboxDomains(p.allowed, p.seeded),
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: SANDBOX_DENY_READ.map((d) => d.replace(/^~/, home)),
      allowWrite: [...new Set(write)],
      denyWrite: [],
    },
  };
}

export type SandboxViolation =
  | { kind: "write"; path: string | null }
  | { kind: "network"; host: string | null };

/**
 * A sandbox refusal in a tool result, or null. Only meaningful for a sandboxed run: outside one,
 * "operation not permitted" has other causes (SIP, a read-only mount) and is not read at all.
 *
 * `host` comes from the caller's knowledge of the command (the proxy's 403 does not name it);
 * `path` is the first absolute path after the refusal, when the tool printed one.
 */
export function sandboxViolation(text: string): SandboxViolation | null {
  if (
    /blocked-by-sandbox-runtime|Connection blocked by network allowlist|connection not allowed by ruleset|CONNECT tunnel failed, response 403/i.test(
      text,
    )
  )
    return { kind: "network", host: null };
  const fs = /operation not permitted\b[^\n]*/i.exec(text);
  if (!fs) return null;
  const path = /(?:^|[\s'":])(\/[^\s'":]+)/.exec(fs[0])?.[1] ?? null;
  return { kind: "write", path };
}
