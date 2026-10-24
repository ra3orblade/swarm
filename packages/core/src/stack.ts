/**
 * Stack detection (M14.1): what a project runs, read from its lockfiles.
 *
 * Pure: the daemon reads the files and hands their text in; nothing here touches the disk, so
 * every parser is tested with a fixture string. Each parser returns what it can read and `[]` for
 * a file it cannot, so one odd lockfile never fails a scan — the daemon records the error on the
 * manifest row instead.
 *
 * Repo-agnostic by construction: the input is text found in the project root, the output is rows.
 * An empty folder is an empty stack.
 */

export type Ecosystem = "npm" | "PyPI" | "GitHub Actions";
/** `runtime` and `development` come from the manifest's own declarations; `""` is unknown or transitive. */
export type Scope = "runtime" | "development" | "";

export interface StackRow {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  scope: Scope;
  /** Repo-relative path of the manifest the row came from. */
  manifest: string;
}

export type ManifestKind =
  | "bun.lock"
  | "pnpm-lock"
  | "npm-lock"
  | "yarn-lock"
  | "uv.lock"
  | "poetry.lock"
  | "requirements"
  | "workflow"
  | "action";

/** Manifest file names looked for in a project root and one level down. */
export const MANIFEST_NAMES: readonly string[] = [
  "bun.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
];

/** One manifest as the daemon last saw it. */
export interface StackManifest {
  path: string;
  kind: ManifestKind;
  packages: number;
  scannedAt: string;
  error: string | null;
}

export interface StackProject {
  projectId: string;
  name: string;
  total: number;
  byEcosystem: Record<Ecosystem, number>;
  byScope: Record<Scope, number>;
  manifests: StackManifest[];
}

/** `GET /v1/stack` */
export interface StackReport {
  /** `[security] stack`; when false nothing is read and the view says so. */
  enabled: boolean;
  /** When the daemon last finished a scan, or null before the first one. */
  scannedAt: string | null;
  projects: StackProject[];
  rows: Array<StackRow & { projectId: string }>;
}

/** Which parser a repo-relative path gets, or null. `bun.lockb` is null on purpose: binary, skipped. */
export function manifestKind(relPath: string): ManifestKind | null {
  const p = relPath.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) return "workflow";
  if (/(^|\/)\.github\/actions\/.+\/action\.ya?ml$/.test(p)) return "action";
  switch (base) {
    case "bun.lock":
      return "bun.lock";
    case "pnpm-lock.yaml":
      return "pnpm-lock";
    case "package-lock.json":
      return "npm-lock";
    case "yarn.lock":
      return "yarn-lock";
    case "uv.lock":
      return "uv.lock";
    case "poetry.lock":
      return "poetry.lock";
    default:
      return /^requirements[-_.a-z0-9]*\.txt$/i.test(base) ? "requirements" : null;
  }
}

/** PEP 503: lower-case, runs of `-`, `_` and `.` become one `-`. */
export function normalizePyPI(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
}

/** `name@version` → parts; the `@` that splits is the last one, so scoped names survive. */
function splitAt(spec: string): { name: string; version: string } | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

/** A version that is a release, not a link, a workspace or a URL. */
function isVersion(v: string): boolean {
  return /^\d/.test(v) && !/[\s/]/.test(v);
}

const row = (
  ecosystem: Ecosystem,
  name: string,
  version: string,
  scope: Scope,
  manifest: string,
): StackRow => ({ ecosystem, name, version, scope, manifest });

/** De-duplicate on (ecosystem, name, version); the first row's scope wins, which is the declared one. */
function dedupe(rows: StackRow[]): StackRow[] {
  const seen = new Map<string, StackRow>();
  for (const r of rows) {
    const k = `${r.ecosystem}\u0000${r.name}\u0000${r.version}`;
    const have = seen.get(k);
    if (!have) seen.set(k, r);
    else if (!have.scope && r.scope) seen.set(k, r);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version, undefined, { numeric: true }),
  );
}

/** Scope by name from `dependencies` / `devDependencies` maps (package.json shape). */
function scopesFromManifest(obj: unknown, into: Map<string, Scope>) {
  if (!obj || typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  const put = (m: unknown, s: Scope) => {
    if (m && typeof m === "object")
      for (const name of Object.keys(m as object))
        if (!into.has(name) || s === "runtime") into.set(name, s);
  };
  put(o.dependencies, "runtime");
  put(o.optionalDependencies, "runtime");
  put(o.peerDependencies, "runtime");
  put(o.devDependencies, "development");
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // bun.lock is JSONC with trailing commas; that is the only deviation seen in practice
    return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  }
}

/** bun.lock (the text format, bun ≥ 1.2). `packages[key][0]` is the resolved `name@version`. */
export function parseBunLock(text: string, manifest = "bun.lock"): StackRow[] {
  const lock = parseJsonLoose(text) as {
    workspaces?: Record<string, unknown>;
    packages?: Record<string, unknown[]>;
  };
  const scopes = new Map<string, Scope>();
  for (const ws of Object.values(lock.workspaces ?? {})) scopesFromManifest(ws, scopes);
  const out: StackRow[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const spec = Array.isArray(entry) ? entry[0] : null;
    if (typeof spec !== "string") continue;
    const parts = splitAt(spec);
    if (!parts || !isVersion(parts.version)) continue; // workspace:, link:, git+ssh…
    const scope = scopes.get(key) ?? scopes.get(parts.name) ?? "";
    out.push(row("npm", parts.name, parts.version, scope, manifest));
  }
  return dedupe(out);
}

/** pnpm-lock.yaml v5 – v9, without a YAML library: the keys under `packages:` carry name and version. */
export function parsePnpmLock(text: string, manifest = "pnpm-lock.yaml"): StackRow[] {
  const lines = text.split(/\r?\n/);
  const scopes = new Map<string, Scope>();
  const out: StackRow[] = [];
  let section: "importers" | "packages" | "other" = "other";
  let depScope: Scope | null = null;
  let depIndent = 0;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const key = line.replace(/:\s*$/, "");
      if (key === "importers") section = "importers";
      else if (key === "packages") section = "packages";
      else if (key === "dependencies" || key === "devDependencies") {
        // v5 lockfiles without `importers:` keep the root deps at the top level
        section = "importers";
        depScope = key === "dependencies" ? "runtime" : "development";
        depIndent = 0;
        continue;
      } else section = "other";
      depScope = null;
      continue;
    }
    if (section === "importers") {
      const m = /^(\s*)(dependencies|devDependencies|optionalDependencies):\s*$/.exec(line);
      if (m) {
        depScope = m[2] === "devDependencies" ? "development" : "runtime";
        depIndent = (m[1] as string).length;
        continue;
      }
      if (depScope && indent === depIndent + 2) {
        // `'@scope/name':` (v6+) or `lodash: 4.17.21` (v5 inline version)
        const t = line.trim();
        const q = t[0] === "'" || t[0] === '"' ? t[0] : null;
        const name = q ? t.slice(1, t.indexOf(q, 1)) : t.replace(/:.*$/, "");
        if (name && !scopes.has(name)) scopes.set(name, depScope);
        else if (name && depScope === "runtime") scopes.set(name, depScope);
      } else if (depScope && indent <= depIndent) depScope = null;
      continue;
    }
    if (section === "packages" && indent === 2 && line.trimEnd().endsWith(":")) {
      let key = line
        .trim()
        .slice(0, -1)
        .replace(/^['"]|['"]$/g, "");
      if (key.startsWith("/")) key = key.slice(1);
      // peer suffixes: `(react@18)` in v6+, `_react@18` in v5
      key = key.replace(/\(.*$/, "").replace(/_.*$/, "");
      let parts = splitAt(key);
      if (!parts) {
        // v5: `@scope/name/1.2.3` or `name/1.2.3`
        const slash = key.lastIndexOf("/");
        if (slash > 0) parts = { name: key.slice(0, slash), version: key.slice(slash + 1) };
      }
      if (!parts || !isVersion(parts.version)) continue;
      out.push(row("npm", parts.name, parts.version, scopes.get(parts.name) ?? "", manifest));
    }
  }
  return dedupe(out);
}

/** package-lock.json: lockfileVersion 2 / 3 `packages`, v1 `dependencies` as the fallback. */
export function parseNpmLock(text: string, manifest = "package-lock.json"): StackRow[] {
  const lock = parseJsonLoose(text) as {
    packages?: Record<string, { version?: string; dev?: boolean; link?: boolean }>;
    dependencies?: Record<string, unknown>;
  };
  const out: StackRow[] = [];
  if (lock.packages && typeof lock.packages === "object") {
    for (const [key, p] of Object.entries(lock.packages)) {
      if (!key || p.link || typeof p.version !== "string" || !isVersion(p.version)) continue;
      const i = key.lastIndexOf("node_modules/");
      if (i < 0) continue; // a workspace package, not a dependency
      const name = key.slice(i + "node_modules/".length);
      out.push(row("npm", name, p.version, p.dev ? "development" : "runtime", manifest));
    }
    return dedupe(out);
  }
  const walk = (deps: Record<string, unknown> | undefined) => {
    if (!deps) return;
    for (const [name, d0] of Object.entries(deps)) {
      const d = d0 as { version?: string; dev?: boolean; dependencies?: Record<string, unknown> };
      if (typeof d.version === "string" && isVersion(d.version))
        out.push(row("npm", name, d.version, d.dev ? "development" : "runtime", manifest));
      walk(d.dependencies);
    }
  };
  walk(lock.dependencies);
  return dedupe(out);
}

/** yarn.lock, classic (v1) and berry; a sibling package.json gives the scope when provided. */
export function parseYarnLock(
  text: string,
  packageJson?: string,
  manifest = "yarn.lock",
): StackRow[] {
  const scopes = new Map<string, Scope>();
  if (packageJson) {
    try {
      scopesFromManifest(JSON.parse(packageJson), scopes);
    } catch {
      // a broken package.json only costs the scope column
    }
  }
  const out: StackRow[] = [];
  let names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      // `"a@^1", "a@~1":` (v1) or `"a@npm:^1, a@npm:^1.2":` (berry); `__metadata:` is skipped
      const head = line.replace(/:\s*$/, "");
      names = [];
      if (head === "__metadata") continue;
      for (const spec of head.split(",")) {
        const s = spec.trim().replace(/^['"]|['"]$/g, "");
        const parts = splitAt(s);
        if (parts && !names.includes(parts.name)) names.push(parts.name);
      }
      continue;
    }
    const m = /^\s+version:?\s+["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (m && names.length) {
      const version = m[1] as string;
      if (isVersion(version) && !version.startsWith("0.0.0-use.local"))
        for (const name of names)
          out.push(row("npm", name, version, scopes.get(name) ?? "", manifest));
      names = [];
    }
  }
  return dedupe(out);
}

/** The `[[package]]` blocks of a TOML lockfile (uv, poetry), each as its raw text. */
function tomlPackageBlocks(text: string): string[] {
  // everything before the first block ([manifest], headers) is not a package
  return text.split(/^\[\[package\]\]\s*$/m).slice(1);
}

/** The body of one `[section]` inside a block: up to the next header or the end. */
function tomlSection(block: string, header: string): string | null {
  const m = new RegExp(
    `^\\[${header.replace(/\./g, "\\.")}\\]([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    "m",
  ).exec(block);
  return m ? (m[1] as string) : null;
}

function tomlString(block: string, key: string): string | null {
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(block);
  return m ? (m[1] as string) : null;
}

/** uv.lock: every `[[package]]` with a registry source; the root (virtual / editable) names the scopes. */
export function parseUvLock(text: string, manifest = "uv.lock"): StackRow[] {
  const scopes = new Map<string, Scope>();
  const found: Array<{ name: string; version: string }> = [];
  for (const block of tomlPackageBlocks(text)) {
    const name = tomlString(block, "name");
    const version = tomlString(block, "version");
    if (!name) continue;
    const source = /^source\s*=\s*\{([^}]*)\}/m.exec(block)?.[1] ?? "";
    const isRoot = /\b(virtual|editable)\s*=/.test(source);
    if (isRoot) {
      const names = (region: string | null, scope: Scope) => {
        if (!region) return;
        for (const d of region.matchAll(/\{\s*name\s*=\s*"([^"]+)"/g)) {
          const n = normalizePyPI(d[1] as string);
          if (!scopes.has(n) || scope === "runtime") scopes.set(n, scope);
        }
      };
      // the root block's own top-level `dependencies = [ … ]`, before any [package.*] section
      const top = block.split(/^\[package\./m)[0] as string;
      names(/^dependencies\s*=\s*\[([\s\S]*?)^\]/m.exec(top)?.[1] ?? null, "runtime");
      names(tomlSection(block, "package.optional-dependencies"), "runtime");
      names(tomlSection(block, "package.dev-dependencies"), "development");
      continue;
    }
    if (version && isVersion(version)) found.push({ name: normalizePyPI(name), version });
  }
  return dedupe(
    found.map((p) => row("PyPI", p.name, p.version, scopes.get(p.name) ?? "", manifest)),
  );
}

/** poetry.lock: `category` (≤ 1.4) or `groups` (2.x) decide the scope. */
export function parsePoetryLock(text: string, manifest = "poetry.lock"): StackRow[] {
  const out: StackRow[] = [];
  for (const block of tomlPackageBlocks(text)) {
    const name = tomlString(block, "name");
    const version = tomlString(block, "version");
    if (!name || !version || !isVersion(version)) continue;
    const category = tomlString(block, "category");
    const groups = /^groups\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1] ?? null;
    let scope: Scope = "";
    if (groups !== null) {
      const g = [...groups.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      scope = g.includes("main") ? "runtime" : g.length ? "development" : "";
    } else if (category === "main") scope = "runtime";
    else if (category === "dev") scope = "development";
    out.push(row("PyPI", normalizePyPI(name), version, scope, manifest));
  }
  return dedupe(out);
}

/** requirements.txt: pinned `name==version` lines only; options, includes and ranges are skipped. */
export function parseRequirementsTxt(text: string, manifest = "requirements.txt"): StackRow[] {
  const out: StackRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([^\s;,]+)/.exec(line);
    if (!m) continue;
    const version = m[2] as string;
    if (!isVersion(version)) continue;
    out.push(row("PyPI", normalizePyPI(m[1] as string), version, "", manifest));
  }
  return dedupe(out);
}

/** GitHub Actions: every `uses: owner/repo[/path]@ref`; local (`./`) and docker references are skipped. */
export function parseWorkflowUses(text: string, manifest: string): StackRow[] {
  const out: StackRow[] = [];
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*["']?([^\s"'#]+)/gm)) {
    const ref = m[1] as string;
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    const at = ref.indexOf("@");
    if (at <= 0) continue;
    const path = ref.slice(0, at);
    const version = ref.slice(at + 1).replace(/^v(?=\d)/, "");
    const segs = path.split("/");
    if (segs.length < 2 || !segs[0] || !segs[1]) continue;
    out.push(row("GitHub Actions", `${segs[0]}/${segs[1]}`, version, "", manifest));
  }
  return dedupe(out);
}

/**
 * Every row from every recognised file. `files` is repo-relative path → text. A `package.json`
 * beside a yarn.lock is read for scope only; unknown paths are ignored, so the daemon can hand over
 * whatever it found.
 */
export function detectStack(files: Record<string, string>): StackRow[] {
  const out: StackRow[] = [];
  for (const [path, text] of Object.entries(files)) {
    const kind = manifestKind(path);
    if (!kind) continue;
    out.push(...parseManifest(kind, path, text, files));
  }
  return dedupe(out);
}

/** One manifest; throws on an unreadable file so the caller can record the error. */
export function parseManifest(
  kind: ManifestKind,
  path: string,
  text: string,
  siblings: Record<string, string> = {},
): StackRow[] {
  switch (kind) {
    case "bun.lock":
      return parseBunLock(text, path);
    case "pnpm-lock":
      return parsePnpmLock(text, path);
    case "npm-lock":
      return parseNpmLock(text, path);
    case "yarn-lock": {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      return parseYarnLock(text, siblings[`${dir}package.json`], path);
    }
    case "uv.lock":
      return parseUvLock(text, path);
    case "poetry.lock":
      return parsePoetryLock(text, path);
    case "requirements":
      return parseRequirementsTxt(text, path);
    case "workflow":
    case "action":
      return parseWorkflowUses(text, path);
  }
}

export function stackSummary(rows: readonly StackRow[]): {
  total: number;
  byEcosystem: Record<Ecosystem, number>;
  byScope: Record<Scope, number>;
  manifests: string[];
} {
  const byEcosystem: Record<Ecosystem, number> = { npm: 0, PyPI: 0, "GitHub Actions": 0 };
  const byScope: Record<Scope, number> = { runtime: 0, development: 0, "": 0 };
  const manifests = new Set<string>();
  for (const r of rows) {
    byEcosystem[r.ecosystem]++;
    byScope[r.scope]++;
    manifests.add(r.manifest);
  }
  return { total: rows.length, byEcosystem, byScope, manifests: [...manifests].sort() };
}
