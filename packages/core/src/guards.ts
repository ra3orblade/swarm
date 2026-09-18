/**
 * The destructive / secrets / tamper rule families (M12.5). Pure detectors over what a tool call
 * asks for; `guardBash` and `guardFile` in `rules.ts` turn a hit into a decision, and the Security
 * report (`security.ts`) counts hits whatever the mode — every family ships `off` for one release
 * and is watched there first (the M9.9 order: observation, then `ask`).
 *
 * Like the rest of the rules these are a **lint, not a sandbox**: they read the command string.
 * An obfuscated command will not match. Each detector is tuned for the case an agent actually
 * produces — `rm -rf "$DIR"/` with `DIR` unset, `curl … | sh`, `cat .env` — and against the
 * everyday command that merely looks similar (`rm -rf node_modules`, `.env.example`).
 */

/** One hit: which family, and a phrase for the reason ("removes the home directory"). */
export interface FamilyHit {
  what: string;
}

/** `~`, `$HOME` and `${HOME}` spelled out, so every path below compares as absolute. */
function expandHome(s: string, home: string): string {
  return s.replace(/(^|[\s="'`:])(?:~|\$HOME|\$\{HOME\})(?=\/|$|[\s"'`])/g, `$1${home}`);
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Split a command into its simple commands, so `cd x && rm -rf y` is checked per part. */
function segments(cmd: string): string[] {
  return cmd
    .split(/\s*(?:&&|\|\||;|\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Words of one simple command, quotes removed (a lint, not a shell parser). */
function words(seg: string): string[] {
  return (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));
}

// ---------- destructive_fs

const SYSTEM_DIRS = [
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/opt",
  "/private",
  "/root",
  "/sbin",
  "/System",
  "/Library",
  "/Applications",
  "/Users",
  "/usr",
  "/var",
];
const SCRATCH = /^(\/tmp|\/private\/tmp|\/var\/folders|\/private\/var\/folders)(\/|$)/;

/** Why removing `target` recursively is out of bounds, or null. */
function dangerousTarget(target: string, home: string, toplevel: string | null): string | null {
  if (/^\$\{?\w+\}?(\/|$)/.test(target) && !target.startsWith(home))
    return `starts with ${target.match(/^\$\{?\w+\}?/)?.[0]} — if that is ever unset, it is /`;
  const t = trimSlash(target.replace(/\/\*$/, "/").replace(/\/\.$/, "/"));
  if (t === "*" || target === "/*") return "removes everything the glob matches, from the top";
  if (t === "." || t === ".." || t.startsWith("../"))
    return "removes the working directory or its parent";
  if (t === home || t === trimSlash(home)) return "removes the home directory";
  if (!t.startsWith("/")) return null;
  if (SYSTEM_DIRS.includes(t)) return `removes ${t}`;
  if (t.split("/").length <= 3 && /^\/(Users|home)\//.test(t))
    return `removes the home directory ${t}`;
  if (SCRATCH.test(t)) return null;
  if (toplevel && !(t === toplevel || t.startsWith(`${trimSlash(toplevel)}/`)))
    return `removes ${t}, outside this repository`;
  return null;
}

/** `rm -rf` on /, ~, .., an unset-variable path, or outside the repo; `find … -delete` at the top; `mkfs`, `dd of=/dev/…`. */
export function destructiveFs(
  cmd: string,
  home: string,
  toplevel: string | null,
): FamilyHit | null {
  const c = expandHome(cmd, home);
  for (const seg of segments(c)) {
    const w = words(seg.replace(/^sudo\s+/, ""));
    if (w[0] === "rm") {
      const flags = w.filter((x) => x.startsWith("-"));
      const recursive = flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive");
      if (!recursive) continue;
      for (const target of w.slice(1).filter((x) => !x.startsWith("-"))) {
        const why = dangerousTarget(target, home, toplevel);
        if (why) return { what: `\`rm -r ${target}\` ${why}` };
      }
    }
    if (w[0] === "find" && (w.includes("-delete") || /-exec\s+rm\b/.test(seg))) {
      const root = w[1] ?? ".";
      const why = dangerousTarget(root, home, toplevel);
      if (why && root !== ".") return { what: `\`find ${root} … -delete\` ${why}` };
    }
    if (/^(mkfs(\.\w+)?|newfs\w*|wipefs)$/.test(w[0] ?? ""))
      return { what: `\`${w[0]}\` formats a disk` };
    if (w[0] === "dd" && w.some((x) => /^of=\/dev\//.test(x)))
      return { what: "`dd` writes over a device" };
    if (w[0] === "diskutil" && /^(erase|zero|secureErase|reformat)/i.test(w[1] ?? ""))
      return { what: `\`diskutil ${w[1]}\` erases a disk` };
    if ((w[0] === "chmod" || w[0] === "chown") && w.some((x) => /^-[a-zA-Z]*R/.test(x))) {
      const target = w[w.length - 1] ?? "";
      if (target.startsWith("/") || target === home) {
        const why = dangerousTarget(target, home, toplevel);
        if (why) return { what: `\`${w[0]} -R ${target}\` ${why.replace(/^removes/, "changes")}` };
      }
    }
  }
  return null;
}

// ---------- destructive_infra

const DB_CLIENT =
  /\b(psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse(-client)?|cockroach|mongo(sh)?|duckdb)\b/i;
const INFRA: Array<{ what: string; re: RegExp; needs?: RegExp }> = [
  {
    what: "`terraform destroy` tears the stack down",
    re: /\b(terraform|tofu)\s+(\S+\s+)*destroy\b/,
  },
  { what: "`terraform state rm` forgets live resources", re: /\b(terraform|tofu)\s+state\s+rm\b/ },
  {
    what: "`kubectl delete` of a namespace or everything",
    re: /\bkubectl\s+(\S+\s+)*delete\s+(\S+\s+)*(ns|namespaces?|pvc?|persistentvolume(claim)?s?|--all\b|-A\b|--all-namespaces\b)/,
  },
  { what: "`kubectl drain` evicts a node's workloads", re: /\bkubectl\s+(\S+\s+)*drain\b/ },
  { what: "`helm uninstall` removes a release", re: /\bhelm\s+(\S+\s+)*(uninstall|delete)\b/ },
  {
    what: "`aws s3 rm --recursive` empties a bucket path",
    re: /\baws\s+s3\s+rm\b[^|;&]*--recursive/,
  },
  { what: "`aws s3 rb` deletes a bucket", re: /\baws\s+s3\s+rb\b/ },
  {
    what: "an AWS delete / terminate call",
    re: /\baws\s+[\w-]+\s+(terminate-instances|delete-(db-instance|db-cluster|stack|table|bucket|cluster|function|user|role|repository))\b/,
  },
  { what: "a `gcloud … delete`", re: /\bgcloud\s+(\S+\s+)+delete\b/ },
  { what: "an `az … delete`", re: /\baz\s+(\S+\s+)+delete\b/ },
  {
    what: "`docker system prune` removes images and volumes",
    re: /\bdocker\s+system\s+prune\b[^|;&]*(-a\b|--all\b|--volumes\b)/,
  },
  { what: "`docker volume rm/prune` deletes data volumes", re: /\bdocker\s+volume\s+(rm|prune)\b/ },
  { what: "a SQL `DROP`", re: /\bdrop\s+(database|schema|table)\b/i, needs: DB_CLIENT },
  { what: "a SQL `TRUNCATE`", re: /\btruncate\s+(table\s+)?\w/i, needs: DB_CLIENT },
  {
    what: "an unbounded SQL `DELETE`",
    re: /\bdelete\s+from\s+[\w."]+\s*(;|"|'|$)/i,
    needs: DB_CLIENT,
  },
  { what: "`dropdb` deletes a database", re: /(^|[\s;&|])dropdb\s/ },
  {
    what: "a database reset",
    re: /\b(prisma\s+migrate\s+reset|rails\s+db:(drop|reset)|rake\s+db:(drop|reset)|supabase\s+db\s+reset)\b/,
  },
  {
    what: "`redis-cli FLUSHALL/FLUSHDB` wipes the store",
    re: /\bredis-cli\b[^|;&]*\bflush(all|db)\b/i,
  },
  { what: "`dropDatabase()` in the Mongo shell", re: /\bdropDatabase\s*\(/, needs: DB_CLIENT },
];

/** Commands that delete infrastructure or data somewhere other than this checkout. */
export function destructiveInfra(cmd: string): FamilyHit | null {
  for (const r of INFRA)
    if (r.re.test(cmd) && (!r.needs || r.needs.test(cmd))) return { what: r.what };
  return null;
}

// ---------- pipe_to_shell

const FETCHER = String.raw`\b(curl|wget|fetch|http|xh)\b`;
const INTERP = String.raw`(sudo\s+(-\S+\s+)*)?(env\s+(\w+=\S+\s+)*)?(ba|z|k|da|fi)?sh|python[0-9.]*|node|perl|ruby|php|iex`;

/** `curl … | sh`, `bash <(curl …)`, `sh -c "$(curl …)"` — running a script nobody read. */
export function pipeToShell(cmd: string): FamilyHit | null {
  if (new RegExp(`${FETCHER}[^|;&]*\\|\\s*(${INTERP})\\b`).test(cmd))
    return { what: "pipes a downloaded script straight into an interpreter" };
  if (/\b((ba|z)?sh|source|\.)\s+<\(\s*(curl|wget)\b/.test(cmd))
    return { what: "runs a downloaded script via process substitution" };
  if (/\b(ba|z)?sh\s+-c\s+["']?\$\(\s*(curl|wget)\b/.test(cmd))
    return { what: "runs a downloaded script via command substitution" };
  return null;
}

// ---------- secrets

/** Credential files by name — never contents. Templates (`.env.example`) are not secrets. */
const SECRET_FILES: Array<{ what: string; re: RegExp }> = [
  {
    what: "a .env file",
    re: /(^|[/\s"'`=@])\.env(\.(?!example\b|sample\b|template\b|dist\b|defaults?\b)[\w-]+)?(?=$|[\s"'`;|&)])/,
  },
  {
    what: "an SSH private key",
    re: /(^|[/\s"'`])(id_rsa|id_ed25519|id_ecdsa|id_dsa)(?=$|[\s"'`;|&)])/,
  },
  { what: "AWS credentials", re: /\.aws\/credentials\b/ },
  { what: "an npm token file", re: /(^|[/\s"'`])\.npmrc\b/ },
  { what: "a kubeconfig", re: /\.kube\/config\b/ },
  { what: "Google Cloud credentials", re: /gcloud\/[\w-]*credential/i },
  { what: "a private key file", re: /[\w-]\.(pem|p12|pfx|key)(?=$|[\s"'`;|&)])/i },
  { what: "a netrc", re: /(^|[/\s"'`])\.netrc\b/ },
];
const READERS =
  /(^|[\s;&|(])(cat|less|more|head|tail|bat|strings|base64|xxd|od|hexdump|grep|egrep|rg|ag|awk|nl|tac|cp|scp|rsync|openssl|gpg|pbcopy)\b|curl\b[^|;&]*(-d|--data[\w-]*|-F|--form|-T|--upload-file)\s*@/;

export function secretFileIn(text: string): string | null {
  return SECRET_FILES.find((s) => s.re.test(text))?.what ?? null;
}

/** A command that reads, prints or ships a credential file, or asks the keychain for one. */
export function secretCommand(cmd: string): FamilyHit | null {
  if (/\bsecurity\s+find-(generic|internet)-password\b[^|;&]*\s-[a-z]*w/.test(cmd))
    return { what: "prints a password from the macOS keychain" };
  if (/\b(printenv|env)\s*(\||>|$)/.test(cmd) && /\|\s*(curl|nc|ncat)\b/.test(cmd))
    return { what: "sends the environment over the network" };
  for (const seg of segments(cmd)) {
    if (!READERS.test(seg)) continue;
    // a copy reads only its sources: `cp .env.example .env` makes a secret, it does not read one
    const w = words(seg);
    const copy = /^(cp|scp|rsync)$/.test(w[0] ?? "");
    const text = copy
      ? w
          .slice(1, -1)
          .filter((x) => !x.startsWith("-"))
          .join(" ")
      : seg;
    const what = secretFileIn(text);
    if (what) return { what: `${copy ? "copies" : "reads"} ${what}` };
  }
  return null;
}

/** File tools: Read of a credential file; Write / Edit of a `.env*` or key file. */
export function secretFile(tool: string, path: string): FamilyHit | null {
  const what = secretFileIn(path);
  if (!what) return null;
  if (tool === "Read") return { what: `reads ${what}` };
  if (/\.env(\.[\w-]+)?$|\.(pem|p12|pfx|key)$/i.test(path)) return { what: `writes ${what}` };
  return null;
}

// ---------- config_tamper

/**
 * The files that decide what an agent may do: Claude Code's settings (hooks and permissions live
 * there), Swarm's own config and state, and the other agents' hook / MCP config Swarm installs.
 */
export function guardConfigFile(path: string, home: string): string | null {
  const p = expandHome(path, home);
  const h = trimSlash(home);
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(p))
    return "Claude Code settings (hooks and permissions)";
  if (p === `${h}/.claude.json`) return "Claude Code's MCP registration";
  if (p.startsWith(`${h}/.swarm/`) || p === `${h}/.swarm`) return "Swarm's config and ledger";
  if (/(^|\/)\.swarm\.toml$/.test(p)) return "this repo's Swarm rules";
  if (
    p === `${h}/.codex/config.toml` ||
    p === `${h}/.gemini/settings.json` ||
    p === `${h}/.cursor/hooks.json`
  )
    return "another agent's hook config";
  return null;
}

const WRITERS =
  /(^|[\s;&|(])(>>?|tee|rm|mv|cp|truncate|ln|chmod|chown|unlink|shred)\b|>>?\s*\S|\bsed\s+(-[a-zA-Z]*\s+)*-i|\bperl\s+-[a-zA-Z]*i|\bsqlite3\b[^|;&]*\b(delete|update|drop|insert)\b/i;

/** A Bash command that rewrites, removes or edits a guard config file — or uninstalls Swarm. */
export function configTamperCommand(cmd: string, home: string): FamilyHit | null {
  if (/(^|[\s;&|])swarm\s+uninstall\b/.test(cmd)) return { what: "uninstalls Swarm's hooks" };
  for (const seg of segments(expandHome(cmd, home))) {
    if (!WRITERS.test(seg)) continue;
    for (const w of words(seg)) {
      const target = w.replace(/^>+/, "");
      if (!target.includes("/") && !target.startsWith(".")) continue;
      const what = guardConfigFile(target, home);
      if (what) return { what: `changes ${what} (${target})` };
    }
  }
  return null;
}
