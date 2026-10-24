/**
 * The security layer's background work (M14, docs/16).
 *
 * M14.1 stack: every minute, stat each live project's manifests and re-parse only the ones whose
 * mtime or size moved. Read-only, inside the project root, never a write — and no network, so it
 * runs under SWARM_OFFLINE too. The parsers live in core (`stack.ts`); this file only finds files.
 *
 * One service, ticked from the daemon loop like the team forwarder and the OTLP exporter: it keeps
 * its own pacing, never throws, and records what happened in `meta`.
 */
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ManifestKind, manifestKind, parseManifest } from "@swarm/core/stack";
import type { Store } from "./store";

/** Directories never descended into: dependency trees, VCS state, build output. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  "vendor",
]);
/** A lockfile beyond this is not read; the manifest row records why. */
const MAX_BYTES = 20 * 1024 * 1024;
const STACK_EVERY_MS = 60_000;

interface Candidate {
  rel: string;
  abs: string;
  kind: ManifestKind;
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The manifests a project may carry: known names in the root and one level down (monorepos keep
 * `apps/x/requirements.txt`), every workflow, and `action.yml` under `.github/actions` to depth 3.
 */
export function manifestCandidates(root: string): Candidate[] {
  const out: Candidate[] = [];
  const consider = (rel: string) => {
    const kind = manifestKind(rel);
    if (kind) out.push({ rel, abs: join(root, rel), kind });
  };
  for (const e of safeReaddir(root)) {
    if (e.isFile()) consider(e.name);
    else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      for (const f of safeReaddir(join(root, e.name)))
        if (f.isFile()) consider(`${e.name}/${f.name}`);
  }
  for (const f of safeReaddir(join(root, ".github", "workflows")))
    if (f.isFile()) consider(`.github/workflows/${f.name}`);
  const actions = (rel: string, depth: number) => {
    for (const f of safeReaddir(join(root, rel))) {
      if (f.isFile()) consider(`${rel}/${f.name}`);
      else if (f.isDirectory() && depth > 0 && !SKIP_DIRS.has(f.name))
        actions(`${rel}/${f.name}`, depth - 1);
    }
  };
  actions(".github/actions", 3);
  return out;
}

export class SecurityService {
  private lastStack = 0;
  private busy = false;

  constructor(
    private readonly store: Store,
    readonly version: string,
  ) {}

  /** For `doctor` and the view footers. */
  status() {
    const cfg = this.store.policyFor(null).config.security;
    const report = this.store.stackReport();
    return {
      offline: process.env.SWARM_OFFLINE === "1",
      stack: {
        enabled: cfg.stack,
        projects: report.projects.length,
        packages: report.rows.length,
        at: report.scannedAt,
      },
    };
  }

  /** Called from the daemon tick; paces itself. Returns the projects whose stack changed. */
  tick(now = Date.now()): Set<string> {
    if (now - this.lastStack < STACK_EVERY_MS) return new Set();
    this.lastStack = now;
    return this.scanStacks();
  }

  /** Run the stack scan now (the refresh route and the CLI). Never throws. */
  refresh(): ReturnType<SecurityService["status"]> {
    this.lastStack = Date.now();
    this.scanStacks();
    return this.status();
  }

  /**
   * Stat every candidate manifest of every live project and re-parse the changed ones. A project
   * whose root is gone loses its rows without an error; a manifest that cannot be parsed keeps a
   * row with the error, so the view can say which file and why.
   */
  scanStacks(): Set<string> {
    const changed = new Set<string>();
    if (this.busy) return changed;
    this.busy = true;
    try {
      const cfg = this.store.policyFor(null).config.security;
      if (!cfg.stack) return changed;
      const now = new Date().toISOString();
      for (const p of this.store.liveProjects()) {
        try {
          if (this.scanProject(p.id, p.root, now)) changed.add(p.id);
        } catch (e) {
          this.store.setMetaValue("security_stack_error", `${p.name}: ${(e as Error).message}`);
        }
      }
      this.store.setMetaValue("security_stack_at", now);
    } finally {
      this.busy = false;
    }
    return changed;
  }

  private scanProject(projectId: string, root: string, now: string): boolean {
    const known = new Map(this.store.stackManifests(projectId).map((m) => [m.manifest, m]));
    let changed = false;
    if (!existsSync(root)) {
      for (const m of known.keys()) this.store.deleteStackManifest(projectId, m);
      return known.size > 0;
    }
    const seen = new Set<string>();
    for (const c of manifestCandidates(root)) {
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(c.abs);
      } catch {
        continue;
      }
      seen.add(c.rel);
      const mtimeMs = Math.round(st.mtimeMs);
      const k = known.get(c.rel);
      if (k && k.mtimeMs === mtimeMs && k.size === st.size) continue;
      let rows: ReturnType<typeof parseManifest> = [];
      let error: string | null = null;
      if (st.size > MAX_BYTES)
        error = `not read: ${Math.round(st.size / 1_048_576)} MB is over the 20 MB limit`;
      else {
        try {
          const text = readFileSync(c.abs, "utf8");
          const siblings: Record<string, string> = {};
          if (c.kind === "yarn-lock") {
            const dir = c.rel.includes("/") ? c.rel.slice(0, c.rel.lastIndexOf("/") + 1) : "";
            try {
              siblings[`${dir}package.json`] = readFileSync(
                join(root, dir, "package.json"),
                "utf8",
              );
            } catch {
              // no package.json beside it: rows come without a scope
            }
          }
          rows = parseManifest(c.kind, c.rel, text, siblings);
        } catch (e) {
          error = (e as Error).message.slice(0, 200);
        }
      }
      this.store.replaceStackManifest(
        projectId,
        { manifest: c.rel, kind: c.kind, mtimeMs, size: st.size, scannedAt: now, error },
        rows,
      );
      changed = true;
    }
    for (const m of known.keys())
      if (!seen.has(m)) {
        this.store.deleteStackManifest(projectId, m);
        changed = true;
      }
    return changed;
  }
}
