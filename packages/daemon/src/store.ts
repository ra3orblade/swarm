import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type HarnessEvent,
  normalizeHook,
  type Project,
  projectIdentity,
  type Session,
} from "@harness/core";
import { currentBranch, gitCommonDir, gitToplevel, listWorktrees, type Worktree } from "./git";

export const HARNESS_HOME = process.env.HARNESS_HOME ?? join(homedir(), ".harness");

export interface SessionView extends Session {
  branch: string | null;
  last: string;
  lastType: string;
  state: "active" | "waiting" | "ended";
  toolCalls: number;
  subagents: number;
}

/** In-memory event log + projections. Projects persist to ~/.harness/projects.json. */
export class Store {
  events: HarnessEvent[] = [];
  projects = new Map<string, Project>();
  sessions = new Map<string, SessionView>();
  private listeners = new Set<(e: HarnessEvent) => void>();
  private file: string;

  constructor(home = HARNESS_HOME) {
    mkdirSync(home, { recursive: true });
    this.file = join(home, "projects.json");
    if (existsSync(this.file)) {
      for (const p of JSON.parse(readFileSync(this.file, "utf8")) as Project[]) {
        this.projects.set(p.id, p);
      }
    }
  }

  private persist() {
    writeFileSync(this.file, `${JSON.stringify([...this.projects.values()], null, 2)}\n`);
  }

  /** Resolve a folder to a project, registering it (as discovered unless `explicit`). */
  resolveProject(path: string, explicit = false, name?: string): Project {
    const root = gitToplevel(path) ?? realpathSync(path);
    const ident = projectIdentity({ root, commonDir: gitCommonDir(root) });
    let p = this.projects.get(ident.id);
    if (!p) {
      p = { ...ident, discovered: !explicit, createdAt: new Date().toISOString() };
      if (name) p.name = name;
      this.projects.set(p.id, p);
      this.persist();
    } else if (explicit) {
      p.discovered = false;
      if (name) p.name = name;
      this.persist();
    }
    return p;
  }

  removeProject(id: string): boolean {
    const ok = this.projects.delete(id);
    if (ok) this.persist();
    return ok;
  }

  append(e: HarnessEvent): HarnessEvent {
    const stored = { ...e, seq: this.events.length + 1 };
    this.events.push(stored);
    this.project(stored);
    for (const l of this.listeners) l(stored);
    return stored;
  }

  ingestHook(event: string, raw: Record<string, unknown>): HarnessEvent {
    const cwd = typeof raw.cwd === "string" ? raw.cwd : process.cwd();
    const project = existsSync(cwd) ? this.resolveProject(cwd) : null;
    const e = normalizeHook(event, raw, project?.id ?? "p_unknown");
    return this.append(e);
  }

  private project(e: HarnessEvent) {
    if (!e.sessionId) return;
    const p = e.payload as { summary?: string; cwd?: string | null; hook?: string; tool?: string };
    let s = this.sessions.get(e.sessionId);
    if (!s) {
      s = {
        id: e.sessionId,
        projectId: e.projectId,
        kind: "interactive",
        parentId: null,
        cwd: p.cwd ?? "",
        worktree: null,
        branch: null,
        model: null,
        startedAt: e.ts,
        endedAt: null,
        lastSeenAt: e.ts,
        last: "",
        lastType: "",
        state: "active",
        toolCalls: 0,
        subagents: 0,
      };
      this.sessions.set(s.id, s);
    }
    s.lastSeenAt = e.ts;
    s.last = p.summary ?? e.type;
    s.lastType = e.type;
    if (e.projectId !== "p_unknown") s.projectId = e.projectId;
    if (p.cwd) {
      s.cwd = p.cwd;
      if (existsSync(p.cwd)) s.branch = currentBranch(p.cwd);
    }
    if (e.type === "tool.requested") s.toolCalls++;
    if (e.type === "subagent.started") s.subagents++;
    if (e.type === "subagent.stopped") s.subagents = Math.max(0, s.subagents - 1);
    s.state =
      e.type === "session.ended"
        ? "ended"
        : p.hook === "Stop" || e.type === "incident.opened"
          ? "waiting"
          : "active";
    if (e.type === "session.ended") s.endedAt = e.ts;
  }

  since(seq: number): HarnessEvent[] {
    return this.events.filter((e) => (e.seq ?? 0) > seq);
  }
  subscribe(l: (e: HarnessEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private wtCache = new Map<string, { v: Worktree[]; t: number }>();
  worktrees(projectId: string): Worktree[] {
    const p = this.projects.get(projectId);
    if (!p) return [];
    const hit = this.wtCache.get(projectId);
    if (hit && Date.now() - hit.t < 3000) return hit.v;
    const v = listWorktrees(p.root);
    this.wtCache.set(projectId, { v, t: Date.now() });
    return v;
  }

  snapshot() {
    const worktrees: Record<string, Worktree[]> = {};
    for (const id of this.projects.keys()) worktrees[id] = this.worktrees(id);
    return {
      projects: [...this.projects.values()],
      worktrees,
      sessions: [...this.sessions.values()].sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1)),
      seq: this.events.length,
    };
  }
}
