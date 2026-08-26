/**
 * Security audit (M9.9): what agents reached for that a person might want to know about.
 *
 * Three things are visible in what Swarm already records, and all three are **observations, not
 * enforcement** — this module never denies anything. That is deliberate and matches the roadmap:
 * observation first, an `ask` rule second, once you know what your fleet actually does.
 *
 * - **Egress.** Hosts that appeared in a command or a fetch. A domain here means an agent named it,
 *   not that bytes left the machine: `echo https://example.com` counts, because from the outside
 *   the two are indistinguishable without running the command, and over-reporting is the safe
 *   direction for a security view.
 * - **Installs.** Package installs, by ecosystem. These change what the machine will execute later,
 *   which is worth a record even when every one of them is fine.
 * - **Secret reads.** Files whose *names* say they hold credentials. Swarm reads the path, never
 *   the contents, so this says "something opened your `.env`" and nothing whatsoever about what
 *   was in it.
 *
 * Everything is matched on the recorded command string. That means it is a **lint, not a sandbox**:
 * an obfuscated command will not match, and a comment mentioning `.env` will. Sold as what it is.
 */

/** One tool call worth scanning, from a `tool.requested` event. */
export interface ScanRow {
  sessionId: string;
  tool: string;
  /** Bash command, or the URL for a fetch-shaped tool. */
  command: string;
  /** `toolInput.file_path`, when the tool had one. */
  path?: string | null;
  at: string;
}

export type Finding = "egress" | "install" | "secret";

export interface EgressHost {
  host: string;
  hits: number;
  sessions: number;
  /** Loopback and link-local: the fleet talking to itself, not to the internet. */
  local: boolean;
}

export interface InstallHit {
  ecosystem: string;
  /** The package as written, or "(unnamed)" when the command installs from a manifest. */
  pkg: string;
  hits: number;
  sessions: number;
}

export interface SecretHit {
  what: string;
  hits: number;
  sessions: number;
}

export interface SecurityReport {
  egress: EgressHost[];
  installs: InstallHit[];
  secrets: SecretHit[];
  totals: {
    scanned: number;
    /** Hosts that are not loopback. */
    remoteHosts: number;
    installs: number;
    secrets: number;
  };
}

const LOCAL =
  /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/** Hostnames named anywhere in a string. Deliberately generous — see the module note. */
export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bhttps?:\/\/(\[[^\]]+\][^/\s"'`)}>,;]*|[^/\s"'`)\]}>,;]+)/gi)) {
    const hostPort = (m[1] as string).replace(/^[^@]*@/, ""); // drop user:pass@
    // Cut at the first colon rather than stripping a trailing `:\d+`: real commands write
    // `127.0.0.1:$PORT`, and a numeric-only strip left `127.0.0.1:$p` as its own "host".
    const bracket = /^\[([^\]]+)\]/.exec(hostPort); // [::1]:7777
    const host = ((bracket?.[1] ?? hostPort.split(":")[0]) as string).toLowerCase();
    if (host) out.add(host);
  }
  return [...out].sort();
}

/** Package managers, and how they say "install". Anchored: these must be in command position. */
const INSTALLERS: Array<{ ecosystem: string; re: RegExp }> = [
  { ecosystem: "npm", re: /^npm\s+(?:i|install|add)\b(.*)$/i },
  { ecosystem: "pnpm", re: /^pnpm\s+(?:i|install|add)\b(.*)$/i },
  { ecosystem: "yarn", re: /^yarn\s+add\b(.*)$/i },
  { ecosystem: "bun", re: /^bun\s+(?:i|install|add)\b(.*)$/i },
  { ecosystem: "pip", re: /^pip3?\s+install\b(.*)$/i },
  { ecosystem: "cargo", re: /^cargo\s+(?:add|install)\b(.*)$/i },
  { ecosystem: "go", re: /^go\s+(?:get|install)\b(.*)$/i },
  { ecosystem: "gem", re: /^gem\s+install\b(.*)$/i },
  { ecosystem: "brew", re: /^brew\s+install\b(.*)$/i },
  { ecosystem: "apt", re: /^(?:sudo\s+)?apt(?:-get)?\s+install\b(.*)$/i },
];

/**
 * What a package name can look like across the ecosystems above: `left-pad`, `@scope/pkg`,
 * `requests==2.1`, `github.com/x/y`, `serde_json`. Notably not `&1`, `/dev/null` or `follows`.
 */
const PKG_NAME = /^(@[\w.-]+\/)?[a-z0-9][\w.\-/]*([@=<>~^]=?[\w.\-^~*]+)?$/i;

/**
 * Installs named in a command. A bare `npm install` (from the manifest) still counts.
 *
 * The installer must be in **command position** — the start of the string or of a segment after a
 * separator. Matching it anywhere turned the sentence "then npm install and the rest follows" into
 * four packages called `and`, `the`, `rest` and `follows`, and agent commands are full of prose in
 * heredocs and commit messages.
 */
export function installsIn(text: string): Array<{ ecosystem: string; pkg: string }> {
  const out: Array<{ ecosystem: string; pkg: string }> = [];
  for (const raw of text.split(/&&|\|\||[;\n|]/)) {
    const segment = raw.trim();
    if (!segment) continue;
    for (const { ecosystem, re } of INSTALLERS) {
      const m = re.exec(segment);
      if (!m) continue;
      const args: string[] = [];
      for (const tok of (m[1] ?? "").split(/\s+/)) {
        const a = tok.trim();
        if (!a) continue;
        // Everything from the first redirection on describes where output goes, not what to install.
        if (/^\d*[<>&]/.test(a)) break;
        if (a.startsWith("-")) continue;
        if (PKG_NAME.test(a)) args.push(a);
      }
      out.push(
        ...(args.length
          ? args.map((pkg) => ({ ecosystem, pkg }))
          : [{ ecosystem, pkg: "(from manifest)" }]),
      );
    }
  }
  return out;
}

/** Paths and commands whose names say "credential". Names only — never contents. */
const SECRETS: Array<{ what: string; re: RegExp }> = [
  { what: ".env file", re: /(^|[/\s"'`])\.env(\.[\w-]+)?\b/i },
  { what: "SSH private key", re: /(^|[/\s"'`])(id_rsa|id_ed25519|id_ecdsa|id_dsa)\b/i },
  { what: "AWS credentials", re: /\.aws\/(credentials|config)\b/i },
  { what: "npm token", re: /(^|[/\s"'`])\.npmrc\b/i },
  { what: "kubeconfig", re: /\.kube\/config\b/i },
  { what: "Google cloud credentials", re: /gcloud\/[\w-]*credential/i },
  { what: "PEM or key file", re: /\.(pem|p12|pfx|key)\b/i },
  { what: "macOS keychain", re: /\bsecurity\s+find-(generic|internet)-password\b/i },
  { what: "netrc", re: /(^|[/\s"'`])\.netrc\b/i },
];

export function secretsIn(text: string): string[] {
  return SECRETS.filter((s) => s.re.test(text)).map((s) => s.what);
}

export function securityScan(rows: readonly ScanRow[]): SecurityReport {
  const egress = new Map<string, { hits: number; sessions: Set<string> }>();
  const installs = new Map<
    string,
    { ecosystem: string; pkg: string; hits: number; sessions: Set<string> }
  >();
  const secrets = new Map<string, { hits: number; sessions: Set<string> }>();
  let scanned = 0;

  for (const r of rows) {
    if (!r.sessionId) continue;
    const text = `${r.command ?? ""} ${r.path ?? ""}`.trim();
    if (!text) continue;
    scanned++;

    for (const host of hostsIn(text)) {
      const e = egress.get(host) ?? { hits: 0, sessions: new Set<string>() };
      e.hits++;
      e.sessions.add(r.sessionId);
      egress.set(host, e);
    }
    for (const i of installsIn(r.command ?? "")) {
      const key = `${i.ecosystem} ${i.pkg}`;
      const cur = installs.get(key) ?? { ...i, hits: 0, sessions: new Set<string>() };
      cur.hits++;
      cur.sessions.add(r.sessionId);
      installs.set(key, cur);
    }
    for (const what of secretsIn(text)) {
      const cur = secrets.get(what) ?? { hits: 0, sessions: new Set<string>() };
      cur.hits++;
      cur.sessions.add(r.sessionId);
      secrets.set(what, cur);
    }
  }

  const egressList: EgressHost[] = [...egress.entries()]
    .map(([host, e]) => ({
      host,
      hits: e.hits,
      sessions: e.sessions.size,
      local: LOCAL.test(host),
    }))
    .sort(
      (a, b) =>
        Number(a.local) - Number(b.local) || b.hits - a.hits || a.host.localeCompare(b.host),
    );

  return {
    egress: egressList,
    installs: [...installs.values()]
      .map((i) => ({ ecosystem: i.ecosystem, pkg: i.pkg, hits: i.hits, sessions: i.sessions.size }))
      .sort(
        (a, b) =>
          b.hits - a.hits || a.ecosystem.localeCompare(b.ecosystem) || a.pkg.localeCompare(b.pkg),
      ),
    secrets: [...secrets.entries()]
      .map(([what, s]) => ({ what, hits: s.hits, sessions: s.sessions.size }))
      .sort((a, b) => b.hits - a.hits || a.what.localeCompare(b.what)),
    totals: {
      scanned,
      remoteHosts: egressList.filter((h) => !h.local).length,
      installs: [...installs.values()].reduce((n, i) => n + i.hits, 0),
      secrets: [...secrets.values()].reduce((n, s) => n + s.hits, 0),
    },
  };
}
