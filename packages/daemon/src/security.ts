/**
 * The security layer's background work (M14, docs/16).
 *
 * - **M14.1 stack**: every minute, stat each live project's manifests and re-parse only the ones
 *   whose mtime or size moved. Read-only, inside the project root, never a write, no network — so
 *   it runs under SWARM_OFFLINE too. The parsers live in core (`stack.ts`); this file finds files.
 * - **M14.2 news**: every `[security] refresh_minutes`, read the configured RSS / Atom sources
 *   (conditional requests, one retry, per-source backoff), match each item against the union of
 *   every project's stack keywords, and store it. Public feeds; the request carries nothing about
 *   the user. Off under SWARM_OFFLINE or `news = false`.
 *
 * One service, ticked from the daemon loop like the team forwarder and the OTLP exporter: it keeps
 * its own pacing, never throws, and records what happened in `meta`.
 */
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type Advisory,
  chunk,
  hitsFor,
  OSV_API,
  osvQueries,
  parseOsvBatch,
  parseOsvVuln,
} from "@swarm/core/advisories";
import { type FeedCheck, type FeedItem, keywordMatcher, parseFeed } from "@swarm/core/newsfeed";
import { resolveSources } from "@swarm/core/newsfeeds";
import { type ManifestKind, manifestKind, parseManifest } from "@swarm/core/stack";
import type { NewsFeedRow, Store } from "./store";

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
const FEED_TIMEOUT_MS = 20_000;
const FEED_RETRY_MS = 1_000;
const FEED_CONCURRENCY = 6;
/** A whole-run failure (no network) backs off to at most this. */
const NEWS_BACKOFF_MAX_MS = 60 * 60_000;
const OSV_EVERY_MS = 6 * 60 * 60_000;
const OSV_TIMEOUT_MS = 30_000;
const OSV_BACKOFF_MIN_MS = 5 * 60_000;
const OSV_BATCH = 1000;

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

/** What a failed fetch says: the cause's code when Bun gives one, the wait when it timed out. */
function fetchReason(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError") return `no answer in ${FEED_TIMEOUT_MS / 1000} seconds`;
  const cause = err?.cause?.code || err?.cause?.message;
  return cause ? `${err.message} (${cause})` : String(err?.message ?? e);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run at most `width` of the jobs at once. */
async function pooled(jobs: Array<() => Promise<void>>, width: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (job) await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
}

export class SecurityService {
  private lastStack = 0;
  private busyStack = false;
  private lastNews = 0;
  private busyNews = false;
  private newsBackoffMs = 0;
  /** Tests inject a fetch; production uses the global one. */
  fetchFn: typeof fetch = fetch;
  /** Tests point this at a local server. */
  osvBase = OSV_API;
  private lastOsv = 0;
  private busyOsv = false;
  private osvBackoffMs = 0;
  private stackChanged = false;

  constructor(
    private readonly store: Store,
    readonly version: string,
  ) {}

  /** For `doctor` and the view footers. */
  status() {
    const cfg = this.store.policyFor(null).config.security;
    const report = this.store.stackReport();
    const feeds = this.store.newsFeeds();
    return {
      offline: process.env.SWARM_OFFLINE === "1",
      stack: {
        enabled: cfg.stack,
        projects: report.projects.length,
        packages: report.rows.length,
        at: report.scannedAt,
      },
      news: {
        enabled: cfg.news,
        feeds: feeds.filter((f) => f.state !== "off").length,
        errors: feeds.filter((f) => f.state === "error").length,
        at: this.store.metaValue("security_news_at"),
        error: this.store.metaValue("security_news_error"),
      },
      advisories: {
        enabled: cfg.advisories,
        at: this.store.metaValue("security_osv_at"),
        error: this.store.metaValue("security_osv_error"),
        open: cfg.advisories
          ? this.store.advisoryReport().hits.filter((h) => !h.resolvedAt).length
          : 0,
      },
    };
  }

  /** Called from the daemon tick; each branch paces itself. Never throws. */
  async tick(now = Date.now()): Promise<void> {
    let changed = new Set<string>();
    if (now - this.lastStack >= STACK_EVERY_MS) {
      this.lastStack = now;
      changed = this.scanStacks();
    }
    if (changed.size) {
      this.rematchIfNeeded();
      this.stackChanged = true;
    }
    await this.readNews(now);
    await this.readAdvisories(now);
  }

  /** Run one branch now (the refresh route and the CLI). Never throws. */
  async refresh(
    what: "stack" | "news" | "advisories" | "all" = "all",
  ): Promise<ReturnType<SecurityService["status"]>> {
    if (what === "stack" || what === "all") {
      this.lastStack = Date.now();
      this.scanStacks();
      this.rematchIfNeeded();
    }
    if (what === "news" || what === "all") await this.readNews(Date.now(), true);
    if (what === "advisories" || what === "all") await this.readAdvisories(Date.now(), true);
    return this.status();
  }

  // ---------- stack

  /**
   * Stat every candidate manifest of every live project and re-parse the changed ones. A project
   * whose root is gone loses its rows without an error; a manifest that cannot be parsed keeps a
   * row with the error, so the view can say which file and why.
   */
  scanStacks(): Set<string> {
    const changed = new Set<string>();
    if (this.busyStack) return changed;
    this.busyStack = true;
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
      this.busyStack = false;
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

  // ---------- news

  /** The union keyword set as a cheap fingerprint, so a changed stack re-matches stored items once. */
  rematchIfNeeded(): boolean {
    const words = this.store.newsKeywords();
    const hash = Bun.hash(words.join("\n")).toString(36);
    if (this.store.metaValue("security_news_keywords") === hash) return false;
    this.store.rematchNews(keywordMatcher(words));
    this.store.setMetaValue("security_news_keywords", hash);
    return true;
  }

  /**
   * One round over the sources: reconcile the rows with the config, read every live source (six
   * at a time, conditional requests), store the items of the window with their keyword matches.
   * A failing source never stops the others; a whole-run failure backs the round off.
   */
  async readNews(now = Date.now(), force = false): Promise<void> {
    const cfg = this.store.policyFor(null).config.security;
    if (!cfg.news || process.env.SWARM_OFFLINE === "1") return;
    if (!force && now - this.lastNews < cfg.refresh_minutes * 60_000 + this.newsBackoffMs) return;
    if (this.busyNews) return;
    this.busyNews = true;
    this.lastNews = now;
    try {
      this.store.reconcileNewsFeeds(resolveSources(cfg));
      this.rematchIfNeeded();
      const matcher = keywordMatcher(this.store.newsKeywords());
      const nowIso = new Date(now).toISOString();
      const live = this.store
        .newsFeeds()
        .filter((f) => f.state !== "off" && (force || !f.nextTry || f.nextTry <= nowIso));
      await pooled(
        live.map(
          (f) => () => this.readFeed(f, matcher, cfg.news_days, cfg.refresh_minutes, nowIso),
        ),
        FEED_CONCURRENCY,
      );
      this.store.setMetaValue("security_news_at", nowIso);
      this.store.setMetaValue("security_news_error", "");
      this.newsBackoffMs = 0;
    } catch (e) {
      this.store.setMetaValue("security_news_error", fetchReason(e));
      this.newsBackoffMs = Math.min(NEWS_BACKOFF_MAX_MS, Math.max(60_000, this.newsBackoffMs * 2));
    } finally {
      this.busyNews = false;
    }
  }

  private async fetchFeed(f: NewsFeedRow): Promise<Response> {
    const headers: Record<string, string> = {
      accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      "user-agent": `swarm/${this.version}`,
    };
    if (f.etag) headers["if-none-match"] = f.etag;
    if (f.lastModified) headers["if-modified-since"] = f.lastModified;
    const ask = async () => {
      const res = await this.fetchFn(f.url, {
        headers,
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok && res.status !== 304)
        throw Object.assign(new Error(`answered ${res.status}`), { status: res.status });
      return res;
    };
    try {
      return await ask();
    } catch (first) {
      const status = (first as { status?: number }).status;
      if (status && status < 500) throw first; // the feed's own answer; not asked again
      await pause(FEED_RETRY_MS);
      try {
        return await ask();
      } catch (second) {
        throw new Error(`${fetchReason(second)}, on both tries`);
      }
    }
  }

  private async readFeed(
    f: NewsFeedRow,
    matcher: (text: string) => string[],
    newsDays: number,
    refreshMinutes: number,
    nowIso: string,
  ): Promise<void> {
    const since = new Date(Date.parse(nowIso) - newsDays * 86_400_000).toISOString();
    try {
      const res = await this.fetchFeed(f);
      if (res.status === 304) {
        this.store.newsFeedResult(f.url, {
          state: "on",
          note: "",
          lastTry: nowIso,
          lastOk: nowIso,
          failures: 0,
          nextTry: null,
        });
        return;
      }
      const parsed = parseFeed(await res.text());
      if (parsed.format === "none") throw new Error("no RSS item or Atom entry could be read");
      const items: Array<FeedItem & { matched: string[] }> = [];
      for (const i of parsed.items) {
        if (i.published && i.published < since) continue;
        items.push({ ...i, matched: matcher(`${i.title}\n${i.summary}`) });
      }
      this.store.upsertNewsItems(f.url, items, nowIso);
      this.store.newsFeedResult(f.url, {
        state: "on",
        format: parsed.format,
        note: "",
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        lastTry: nowIso,
        lastOk: nowIso,
        items: items.length,
        failures: 0,
        nextTry: null,
      });
    } catch (e) {
      const failures = f.failures + 1;
      // skipped for 2^failures rounds, at most two days of them
      const rounds = Math.min(2 ** failures, 48);
      const nextTry = new Date(Date.parse(nowIso) + rounds * refreshMinutes * 60_000).toISOString();
      this.store.newsFeedResult(f.url, {
        state: "error",
        note: fetchReason(e)
          .replace(/^.*?: /, "")
          .slice(0, 200),
        lastTry: nowIso,
        failures,
        nextTry,
      });
    }
  }

  // ---------- M14.3 the format check

  private checking = false;

  /**
   * Fetch one URL once with the poller's own headers, timeout and parser, and say what came back.
   * Never throws; refused under SWARM_OFFLINE; one check at a time so a pasted URL cannot be used
   * to fan requests out from the daemon.
   */
  async checkFeed(url: string): Promise<FeedCheck> {
    const base: FeedCheck = {
      ok: false,
      url,
      format: null,
      status: null,
      contentType: null,
      title: null,
      items: 0,
      sample: [],
      note: "",
    };
    if (!/^https?:\/\/\S+$/.test(url)) return { ...base, note: "not an http(s) URL" };
    if (process.env.SWARM_OFFLINE === "1")
      return { ...base, note: "SWARM_OFFLINE=1 is set; nothing is fetched" };
    if (this.checking) return { ...base, note: "another check is running; try again in a moment" };
    this.checking = true;
    try {
      const res = await this.fetchFn(url, {
        headers: {
          accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
          "user-agent": `swarm/${this.version}`,
        },
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        redirect: "follow",
      });
      const contentType = res.headers.get("content-type");
      if (!res.ok)
        return { ...base, status: res.status, contentType, note: `answered ${res.status}` };
      const parsed = parseFeed(await res.text());
      const ok = parsed.format !== "none" && parsed.items.length > 0;
      return {
        ...base,
        ok,
        status: res.status,
        contentType,
        format: parsed.format,
        title: parsed.title,
        items: parsed.items.length,
        sample: parsed.items.slice(0, 3),
        note: ok
          ? `${parsed.format} · ${parsed.items.length} item${parsed.items.length === 1 ? "" : "s"}`
          : "no RSS item or Atom entry could be read: not a feed, or a format the reader does not know",
      };
    } catch (e) {
      return { ...base, note: fetchReason(e) };
    } finally {
      this.checking = false;
    }
  }

  // ---------- M14.4 advisories (opt-in)

  /**
   * Ask OSV about the exact versions every live project runs — only when `[security] advisories`
   * is on and not offline; every six hours, after a stack change, or when forced. The query
   * carries each dependency's ecosystem, name and version and nothing else. Never throws.
   */
  async readAdvisories(now = Date.now(), force = false): Promise<void> {
    const cfg = this.store.policyFor(null).config.security;
    if (!cfg.advisories || process.env.SWARM_OFFLINE === "1") return;
    const due = force || this.stackChanged || now - this.lastOsv >= OSV_EVERY_MS;
    if (!due || this.busyOsv) return;
    const next = this.store.metaValue("security_osv_next");
    if (!force && next && Date.parse(next) > now) return;
    this.busyOsv = true;
    this.lastOsv = now;
    const nowIso = new Date(now).toISOString();
    try {
      const projects = this.store.liveProjects();
      const rows = this.store.stackRows();
      const { keys, queries } = osvQueries(rows);
      const idsByKey = new Map<string, Array<{ id: string; modified: string | null }>>();
      for (const [i, part] of chunk(queries, OSV_BATCH).entries()) {
        const res = await this.fetchFn(`${this.osvBase}/querybatch`, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": `swarm/${this.version}` },
          body: JSON.stringify({ queries: part }),
          signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`OSV answered ${res.status}`);
        const partKeys = keys.slice(i * OSV_BATCH, (i + 1) * OSV_BATCH);
        for (const [k, v] of parseOsvBatch(partKeys, await res.json())) idsByKey.set(k, v);
      }
      const known = this.store.knownAdvisories();
      const wanted = new Map<string, string | null>();
      for (const list of idsByKey.values())
        for (const { id, modified } of list)
          if (!known.has(id) || (modified && known.get(id) !== modified)) wanted.set(id, modified);
      const fetched: Advisory[] = [];
      await pooled(
        [...wanted.keys()].map((id) => async () => {
          const res = await this.fetchFn(`${this.osvBase}/vulns/${encodeURIComponent(id)}`, {
            headers: { "user-agent": `swarm/${this.version}` },
            signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
          });
          if (!res.ok) return;
          const a = parseOsvVuln(await res.json());
          if (a) fetched.push(a);
        }),
        FEED_CONCURRENCY,
      );
      if (fetched.length) this.store.upsertAdvisories(fetched, nowIso);
      const ids = [...new Set([...idsByKey.values()].flat().map((v) => v.id))];
      const advisories = this.store.advisoriesById(ids);
      for (const p of projects) {
        const hits = hitsFor(
          p.id,
          rows.filter((r) => r.projectId === p.id),
          idsByKey,
          advisories,
        );
        this.store.syncAdvisoryHits(p.id, hits, nowIso);
      }
      this.store.setMetaValue("security_osv_at", nowIso);
      this.store.setMetaValue("security_osv_error", "");
      this.store.setMetaValue("security_osv_next", "");
      this.stackChanged = false;
      this.osvBackoffMs = 0;
    } catch (e) {
      this.store.setMetaValue("security_osv_error", fetchReason(e));
      this.osvBackoffMs = Math.min(
        OSV_EVERY_MS,
        Math.max(OSV_BACKOFF_MIN_MS, this.osvBackoffMs * 2),
      );
      this.store.setMetaValue("security_osv_next", new Date(now + this.osvBackoffMs).toISOString());
    } finally {
      this.busyOsv = false;
    }
  }
}
