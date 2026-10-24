# 16 · Secure (M14) — design

Status: living. Designed and built 2026-10-24 (M14.1–M14.10, v0.18.0); the sections below are the design, the addendum at the end says what differs in what shipped. Roadmap rows live in [06-roadmap](06-roadmap.md#m14--secure-what-the-project-runs-what-is-known-bad-what-is-happening-around-it--direction-set-2026-10-24); the questions it raises are OQ-31 – OQ-36 in [07-open-questions](07-open-questions.md). Release: **v0.18.0**.

## Why a design doc first

Security today (M9.9) answers one question: *what did the agents reach for* — hosts named, packages installed, credential files opened. It says nothing about **what the project runs**, whether any of that is known to be bad, or **what is happening in the ecosystem around it**. Security incidents in the package ecosystems are frequent enough right now that a dashboard watching every agent on the machine should also be the place that says "this project runs a version with an advisory" and "this is the news that concerns your stack".

An RSS/Atom security feed the author built earlier for another dashboard proved two things that carry over unchanged: the source format (`name`, `url`, `kind`) and a small regex parser that reads RSS `<item>`s and falls back to Atom `<entry>`s cover every real feed tried. Swarm's version has constraints that one did not, and each is easy to get wrong after the fact:

- **Repo-agnostic.** Everything is read from the project root; nothing is ever written into a monitored repository. An empty folder yields an empty stack.
- **No account, no telemetry.** Asking an advisory database about a project means sending its dependency list off the machine. That is off until the user turns it on, and the switch says exactly what leaves.
- **The hook fast path.** A rule that asks before an agent installs a vulnerable version must answer from a local table in well under the shim's 400 ms, never from the network.
- **Config layering.** `merge()` replaces arrays, so "add one feed" must not silently drop the defaults, and a cloned repo's `.swarm.toml` must not be able to make the daemon fetch URLs of its choosing.

This doc records where the code is today and what changes, so M14 lands as seven small PRs, each useful alone.

## Where the code is today (2026-10-24)

| Concern | Today | Pointer |
|---|---|---|
| Security view | per-project scan of recorded `tool.requested` commands: egress hosts, installs by ecosystem (`INSTALLERS`), credential files by name, and how often each M12.5 rule family would fire; observation only | `packages/core/src/security.ts` `securityScan`, `store.security()`, `GET /v1/security`, `packages/web/src/views/Security.tsx` |
| Stack / lockfiles | nothing reads a lockfile; the only ecosystem knowledge is the installer list above | — |
| Advisories, feeds | nothing; no CVE / OSV / RSS code anywhere | — |
| Projects | `projects` table; `store.liveProjects()` drops discovered scratch roots and is the list anything touching disk must use; all worktrees of a repo share one project id | `packages/daemon/src/store.ts`, `packages/core/src/project-id.ts` |
| Config | `[notify]`, `[otel]`, `[team]` are global-only (read via `policyFor(null)`); `merge()` deep-merges objects and **replaces arrays**; `validate()` clamps and never throws; `[[rules.custom]]` / `[[signals]]` show the array-of-tables parser shape | `packages/core/src/config.ts` `SwarmConfig`, `DEFAULT_CONFIG`, `validate`, `parseCustomRules`; `packages/core/src/signals.ts` |
| Background work | one 5 s tick in the daemon with `tick % N` cadences; self-paced services (`TeamForwarder.tick`, `OtelExporter.tick`) keep `lastTry`, a `busy` flag, backoff and cursors in `meta`, and never throw | `packages/daemon/src/bin.ts`, `team.ts`, `otel.ts` |
| Outbound fetch | the price table (`refreshPricing`: `AbortSignal.timeout`, disk cache, skipped under `SWARM_OFFLINE=1`), the incident webhook, the Linear task source | `packages/daemon/src/store.ts` |
| Incidents | `append({type: "incident.opened", payload: {rule, …}})` with a dedupe map, as `checkSignals` does; the webhook, the nav badge and the Incidents view follow for free | `store.ts` `checkSignals`, `append` |
| Rule families | a pure detector in `guards.ts` returns `FamilyHit`; the id joins `FAMILY_RULES`, `familyHitsBash`, `FAMILY_REASON`, `RuleModes` / `DEFAULT_MODES`, and `RulesConfig`; `guardBash(cmd, current, sessions, now, modes, ctx)` takes a `ctx` the store builds in `rewriteCtx()` inside `evaluateTool()` | `packages/core/src/guards.ts`, `rules.ts`; `store.ts` `evaluateTool`, `rewriteCtx` |
| Schema | `SCHEMA` of `CREATE TABLE IF NOT EXISTS`; `SCHEMA_VERSION = 5` bumps only with a back-fill step (`actor.test.ts` asserts it) | `store.ts` |
| Dashboard | views registered once in `VIEW_DEFS`; project filter is `useUiStore.project` → `?project=`; per-view data via `useResource(route, pollMs)`; tabs are the `.chips` / `.chip on` buttons Graphs and Incidents use (there is no Tabs component); lists are `DataGrid` with module-scope columns | `packages/web/src/app/views.ts`, `api/endpoints.ts`, `views/Graphs.tsx`, `views/Incidents.tsx`, `src/README.md` |
| Desktop | the webview may reach only `127.0.0.1`; there is no HTTP plugin | `apps/desktop/src-tauri/capabilities/default.json` |

## Decisions already taken (2026-10-24)

1. **Advisories are off until enabled.** Stack detection is local and always on. No package name or version leaves the machine until `[security] advisories = true`. `SWARM_OFFLINE=1` silences every fetch in this milestone. (OQ-33)
2. **Nav.** The existing **Security** view grows three tabs — **Activity** (today's content) · **Stack** · **Advisories**. **News** is its own view in the Guard group, scoped by the selected project: with a project selected, items are ranked by that project's stack-derived keywords; with *All projects*, by the union.
3. **Ecosystems in the first cut:** `bun.lock` (the text format), `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` (v1 and berry), `uv.lock`, `poetry.lock`, `requirements.txt` (pinned `==` lines, PEP 503 names), and GitHub Actions `uses:` lines. Rust, Go and Ruby are a later task.
4. **Act, not only report.** A new advisory on a project opens an incident, and a `vulnerable_install` rule family asks (by default) before an agent installs an exact version with a known advisory — from a local SQLite read.

## What the earlier feed does, and what Swarm keeps or changes

**Kept.** The source shape `{ name, url, kind }` with four kinds — `vendor` (a project's own security channel), `authority` (CERTs and agencies), `press` (security press and vendor blogs), `ai` (the AI press) — so a source list written for that feed drops into `[[security.feeds]]` unchanged. The parser: RSS `<item>` (`title`, `link` or `guid`, `pubDate` or `dc:date`, `description` or `content:encoded`), falling back to Atom `<entry>` (`link rel=alternate`, `published` or `updated`, `summary` or `content`); items without a title or an http(s) link are dropped. Plain text at 280 characters on a word boundary. Dedupe by URL without query and fragment. `vendor` and `ai` items are shown whole; `authority` and `press` items only when they name a keyword, and the matched words are shown as tags. Per-source state `{ state: on | error, note, items }`. A 20 s timeout and one retry on a network error or a 5xx.

**Changed.**
- **Keywords come from the stack.** The earlier feed kept a hand-written list of vendors, products and words. Swarm derives the set per project from the detected packages (plus `[security] keywords`), so relevance follows what the project actually runs and needs no upkeep. The heuristics are OQ-35.
- **SQLite, not a JSON file in the temp dir.** Items, per-source state and the advisory cache are tables in `~/.swarm/swarm.db`, pruned on the daily schedule, so a project added later is matched against items already fetched and a restart loses nothing.
- **Conditional requests.** `ETag` / `Last-Modified` per source, and a per-source backoff, so thirty feeds every half hour cost little on a metered connection.
- **Pictures from the article page, once.** A feed that gives no picture would leave a hero blank, so the daemon asks the article's own page for its Open Graph picture — the head of the page only, once in the item's life, `[security] pictures = false` keeps it to one fetch per feed. (v0.18.0 shipped the News as a table without this; M14.11 made it a paper.)
- **Malicious-package advisories rank `critical`.** OSV `MAL-*` entries carry no CVSS; a malicious package is the worst case, not an unknown.

## M14.1 — Stack detection (`core`, local, always on)

### Module

`packages/core/src/stack.ts`, pure, tested with fixture strings beside it:

```ts
export type Ecosystem = "npm" | "PyPI" | "GitHub Actions";
export type Scope = "runtime" | "development" | "";       // "" = unknown or transitive
export interface StackRow { ecosystem: Ecosystem; name: string; version: string; scope: Scope; manifest: string }
export type ManifestKind =
  | "bun.lock" | "pnpm-lock" | "npm-lock" | "yarn-lock"
  | "uv.lock" | "poetry.lock" | "requirements" | "workflow" | "action";

/** Which parser a repo-relative path gets, or null. `bun.lockb` is null on purpose: binary, skipped. */
export function manifestKind(relPath: string): ManifestKind | null;
/** Every row from every recognised file. `files` is repo-relative path → text; a `package.json`
 *  beside a yarn.lock is read for scope only. Unknown paths are ignored. */
export function detectStack(files: Record<string, string>): StackRow[];
export function parseBunLock(text: string): StackRow[];        // JSONC; packages[k][0] = "name@version"; scope from workspaces[""]
export function parsePnpmLock(text: string): StackRow[];       // v6 / v9 `packages:` keys, with or without a leading slash
export function parseNpmLock(text: string): StackRow[];        // lockfileVersion 2 / 3 `packages`; v1 `dependencies` as fallback
export function parseYarnLock(text: string, packageJson?: string): StackRow[];  // v1 and berry
export function parseUvLock(text: string): StackRow[];         // root package deps → runtime, dev-dependencies → development
export function parsePoetryLock(text: string): StackRow[];     // `category` (≤ 1.4) or `groups` (2.x) → scope
export function parseRequirementsTxt(text: string): StackRow[];// `name==version` only; extras stripped; `-r`, `-e`, options ignored
export function parseWorkflowUses(text: string): StackRow[];   // `uses: owner/repo[/path]@ref` → name owner/repo, version ref sans leading v
export function normalizePyPI(name: string): string;           // PEP 503: lower-case, runs of [-_.] → "-"
export function stackSummary(rows: readonly StackRow[]): {
  total: number; byEcosystem: Record<Ecosystem, number>; byScope: Record<Scope, number>; manifests: string[];
};
```

Each parser returns what it can read; a file it cannot parse yields `[]` and the manifest row records the error, so one odd lockfile never fails the scan. `requirements.txt` rows have scope `""` (the file does not say). GitHub Actions rows keep every `owner/repo` (Swarm has no organisation to exclude); the advisory step later ignores refs that are not dotted versions.

### Daemon

Every 60 s, synchronously and also under `SWARM_OFFLINE` (no network is involved), for each `store.liveProjects()` with `[security] stack = true`:

- Candidate manifests: the known names in the root and one directory level down (monorepos keep `apps/x/requirements.txt`), `.github/workflows/*.yml|yaml`, and `.github/actions/**/action.yml|yaml` to depth 3. `node_modules`, `.git`, `.venv`, `dist`, `build` and files over 20 MB are skipped.
- `stat` each candidate and compare `(mtime, size)` with `stack_manifests`; only changed files are read and parsed. Rows are replaced per `(project, manifest)` in one transaction. A manifest that vanished loses its rows; a project root that no longer exists loses all of them, without an error.
- The set of changed project ids is returned so the news matcher (M14.2) and the advisory fetch (M14.4) can react.

Route: `GET /v1/stack?project=` → `{ scannedAt, projects: [{ projectId, name, total, byEcosystem, byScope, manifests: [{ path, kind, packages, scannedAt, error }] }], rows }`, rows for the selected project or for every live project.

### Dashboard

The **Stack** tab on Security: a stat row (total, one per ecosystem, manifests), a "Manifests" panel (path, kind, packages, scanned, error as a warning badge), and a `DataGrid` (project — hidden when one is selected —, ecosystem, name, version, scope, manifest). Empty state names the files Swarm looks for.

## M14.2 — News feed (`core` + daemon + view)

### Module

`packages/core/src/newsfeed.ts` (pure) and `packages/core/src/newsfeeds.ts` (the built-in source list):

```ts
export type NewsKind = "vendor" | "authority" | "press" | "ai";
export const WHOLE_KINDS: ReadonlySet<NewsKind>;                 // vendor, ai — shown without a keyword match
export interface FeedSource { name: string; url: string; kind: NewsKind }
export interface FeedItem { title: string; url: string; published: string; summary: string; image: string | null }
export interface ParsedFeed { format: "rss" | "atom" | "none"; title: string | null; items: FeedItem[] }

export function parseFeed(xml: string): ParsedFeed;              // reports which branch produced items — the check needs `format`
export function plainText(html: string, max?: number): string;   // CDATA, entities (twice), tags, whitespace; 280 default
export function normalizeUrl(url: string): string;               // dedupe key: lower-case scheme + host, no query / fragment / trailing slash
export function keywordMatcher(keywords: readonly string[]): (text: string) => string[];  // whole-word, unicode, case-insensitive, compiled once per set
export function stackKeywords(rows: readonly StackRow[], extra?: readonly string[]): string[];
export function isRelevant(item: { kind: NewsKind; matched: string[] }, keywords: ReadonlySet<string>): boolean;
export function parseSecurityFeeds(raw: unknown): FeedSource[];  // the config parser, in the shape of parseCustomRules

export const BUILTIN_FEEDS: readonly FeedSource[];               // newsfeeds.ts
```

`stackKeywords` is the one new idea; the heuristics (OQ-35) are:

- ecosystem words — npm → `npm`, `Node.js`; PyPI → `PyPI`, `pip`, `Python`; GitHub Actions → `GitHub Actions`;
- runtime and unknown-scope package names of four characters or more, with the npm scope dropped (`@hono/node-server` gives `hono/node-server` and `hono`), minus a stop-list of package names that are ordinary English words (`debug`, `glob`, `chalk`, `commander`, `semver`, `uuid`, `path`, `util`, `types`, `test`, `core`, `common`, `client`, `server`, …); development-scope packages are excluded because lint tooling is noise;
- an alias table adds the human name beside the package — `next` → `Next.js`, `react` → `React`, `pg` / `postgres` → `PostgreSQL`, `django`, `fastapi`, `flask`, `hono`, `express`, `tauri`, `electron`, `vite`, `prisma`, `redis`, `openai`, `@anthropic-ai/sdk` → `Anthropic` — which is also the only way a two-letter name gets in;
- GitHub Actions names as written (`actions/checkout`);
- plus `[security] keywords`; de-duplicated case-insensitively, capped at 300, frameworks and runtime dependencies first.

**Built-in sources ship in code and user entries are appended.** Three reasons: `merge()` replaces arrays, so a user who writes one `[[security.feeds]]` must not lose the defaults; defaults have to move with releases (a feed dies, a vendor moves its URL) without every user editing TOML; and `feeds_off` by name is a cleaner opt-out than copying a list to delete from it. The built-in list is the earlier feed's public sources — ten vendor channels (Node.js, Python, PyPI, Django, PostgreSQL, GitHub, AWS, HashiCorp, Next.js, …), two authorities (CISA, CERT-Bund), fifteen security press and vendor blogs, and eighteen AI press feeds behind the `ai` kind, which is off by default (OQ-31). A config entry with the same URL as a built-in replaces it.

### Daemon

Items are matched **at fetch time** against the **union** of every live project's keyword set plus `[security] keywords`, and the hits are stored on the item; a read for one project intersects them with that project's set. When the union changes (a new project, a lockfile change, a new config keyword — tracked as a hash in `meta`), stored items are matched again once, in a transaction. At thirty days times thirty feeds this is a few thousand rows; FTS5 is the fallback if it is ever slow.

Every `refresh_minutes` (30), unless `news = false` or `SWARM_OFFLINE`: reconcile `news_feeds` with the built-ins (minus `feeds_off`; kinds outside `kinds` are `off`) plus the config entries; fetch the live ones six at a time with a 20 s timeout, an RSS/Atom `accept` header, `user-agent: swarm/<version>` and nothing else identifying, and `if-none-match` / `if-modified-since` from the row. A 304 touches `last_ok`; a 200 runs `parseFeed` — `format: "none"` marks the source `error` with the note *no RSS item or Atom entry could be read*, otherwise items inside `news_days` are upserted (title, summary and matches refreshed, `read_at` kept). A source that keeps failing is skipped for `min(2^failures, 48)` rounds; a failing source is never a reason not to read the others. A whole-run failure (no network) sets `security_news_error` in `meta` and doubles the run backoff up to an hour.

Routes: `GET /v1/news?project=&kind=a,b&days=&unread=1&all=1` → `{ since, keywords, counts: { shown, unread, total }, items: [{ key, feed, kind, title, url, published, summary, image, matched, read }], feeds: { on, error, off }, lastFetch, enabled, offline }` (`all=1` includes authority / press items that matched nothing); `POST /v1/news/read { keys? , all?, project? }`.

### Dashboard

`News` joins `VIEW_DEFS` in the Guard group with the `broadcast` icon (already in the pixelarticons subset). The view is a `DataGrid`, newest first — when · feed · kind badge · title (an external link, routed through the delegated opener so the desktop webview never navigates) · matched keywords · read — with a chip per kind, *Unread*, *All items*, *Mark all read*, and *Sources* (M14.3). Empty states say why: `SWARM_OFFLINE=1`, `news = false`, no project keywords yet (select a project with a lockfile or add `keywords`), or nothing matched. The data hook polls every 30 s; the feed itself moves every 30 min. No nav badge in this release (badges come from the snapshot only); the unread count sits in the section hint.

## M14.3 — Custom sources, and the format check

`[[security.feeds]]` entries (`name`, `url`, `kind`, default kind `press`) are appended to the built-ins; `feeds_off = ["Dark Reading"]` skips built-ins by name. The section is **global-only** (`~/.swarm/config.toml`): the same reason `[notify]` and `[otel]` are, plus one — a cloned repository's `.swarm.toml` must not be able to make the daemon fetch URLs of its choosing. `parseSecurityFeeds` follows `parseCustomRules`: a name of up to 60 characters, an `http(s)` URL, a known kind, duplicates by normalised URL dropped, malformed entries dropped with a warning, never a throw.

**The check.** `POST /v1/news/feeds/check { url }` fetches the URL once with the poller's own headers and timeout and runs the very same `parseFeed`, answering `{ ok, format: "rss" | "atom" | "none", status, contentType, title, items, sample: FeedItem[3], note }`; `ok` is true only when the format is not `none` and at least one item came back. This is the answer to "does this source apply to the format we use": not a guess from the URL, but the parser that will run every half hour. Refused under `SWARM_OFFLINE` with a note; a non-http(s) URL is a 400; one check in flight at a time. `GET /v1/news/feeds` lists every source with `{ name, kind, url, source: builtin | config, state, format, note, items, lastOk, lastTry }`.

**Sources panel** on News: one row per source (state as a badge — `on`, `error` with its note, `off` —, format, items, last read) with a **Check** action per row, and an **Add a source** line: a URL field and **Check**. On `ok` it shows the `[[security.feeds]]` block to paste with a Copy button and the detected format; on `none` it shows the status and content type, so a 403 is told apart from a page that is not a feed. The daemon does not write `config.toml` (OQ-32).

## M14.4 — Advisories via OSV (opt-in)

### Module

`packages/core/src/advisories.ts`, pure:

```ts
export type Severity = "critical" | "high" | "medium" | "low" | "unknown";
export const OSV_API = "https://api.osv.dev/v1";
export interface AdvisoryPackage {
  ecosystem: Ecosystem; name: string;
  ranges: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
  versions: string[]; fixed: string | null;
}
export interface Advisory {
  id: string; aliases: string[]; summary: string; severity: Severity; cvss: number | null;
  url: string; published: string | null; modified: string | null; packages: AdvisoryPackage[];
}
export function queryable(row: StackRow): boolean;                 // a dotted version; not a bare major, not a commit sha
export function osvQueries(rows: readonly StackRow[]): { keys: string[]; queries: OsvQuery[] };  // distinct (ecosystem, name, version), PyPI names normalised, chunks of 1000
export function parseOsvBatch(keys: readonly string[], body: unknown): Map<string, string[]>;
export function parseOsvVuln(body: unknown): Advisory | null;      // MAL-* → critical
export function severityOf(v: unknown): { severity: Severity; cvss: number | null };  // database_specific first, else a CVSS v3 / v4 base score banded 9 / 7 / 4 / > 0
export function compareVersions(a: string, b: string): number;     // numeric dotted compare; pre-release and build dropped
export function inRange(version: string, pkg: AdvisoryPackage): boolean;  // explicit `versions` wins; else introduced ≤ v < fixed / ≤ last_affected
export function severityAtLeast(s: Severity, min: Severity): boolean;
export function advisoryReason(a: Advisory, pkg: { name: string; version: string; fixed: string | null }): string;
// "hono 4.6.3 has a known high advisory (GHSA-…): <summary>. Fixed in 4.6.5."
```

### Daemon

Only when `[security] advisories = true` and not `SWARM_OFFLINE`: every 6 h, and after any stack change, `POST /v1/querybatch` with the distinct queryable rows of every live project, then `GET /v1/vulns/{id}` for ids not yet cached (or cached with an older `modified`), six at a time, 30 s timeout. Per project, `syncAdvisoryHits` inserts new hits with `first_seen`, touches `last_seen` on known ones and sets `resolved_at` on hits whose version left the stack. A failure sets `security_osv_error` and backs off, doubling up to 6 h.

**What the query carries:** the ecosystem, name and version of each dependency — the project's dependency list — and nothing else. That sentence appears in the config reference, the privacy guide, the Enable card and the CLI (OQ-33).

Route: `GET /v1/advisories?project=` → `{ enabled, offline, lastFetch, lastError, minSeverity, counts: Record<Severity, number>, hits: [{ projectId, advisory, ecosystem, name, version, fixed, manifest, scope, firstSeen, resolvedAt, acked }], enable: { file: "~/.swarm/config.toml", toml: "[security]\nadvisories = true", sends: "…" } }`.

### Dashboard

The **Advisories** tab: when off, an **Enable advisories** panel — what it does, exactly what is sent, the two TOML lines with a Copy button, and *takes effect within a minute* (the daemon re-reads global config every 30 s; it never writes `config.toml` itself). When on: a stat row per severity, then a `DataGrid` — severity badge (critical / high red, medium amber, low / unknown plain), advisory id as an external link, package with its ecosystem, version → fixed, manifest, first seen, project — with the usual leading status dot (waiting for an open critical / high, idle otherwise, ended when resolved), and a footer naming what OSV was asked and when.

## M14.5 — Act: the incident and `vulnerable_install`

**Incident.** For each open hit at or above `advisory_min_severity` whose `incident_seq` is null, the daemon appends `incident.opened { rule: "security.advisory", action: "warn", command: "<ecosystem> <name>@<version>", reason: advisoryReason(…), advisory, severity, fixed, manifest }` and stores the sequence number, so each advisory × project fires once. The webhook, the Incidents view and the nav badge need no new code.

**Rule family.** `guards.ts` gains:

```ts
export interface InstallTarget { ecosystem: "npm" | "PyPI"; name: string; version: string }
/** Exact versions an install command names: `npm i a@1.2.3`, `bun add @s/a@1.2.3`, `pnpm add`, `yarn add`,
 *  `pip install a==1.2.3`, `uv pip install`, `uv add a==1.2.3`, `poetry add a@1.2.3`. Ranges, tags and bare
 *  names are not targets — there is nothing to look up without the network. */
export function installTargets(cmd: string): InstallTarget[];
export type VulnLookup = (t: InstallTarget) => { id: string; severity: Severity; fixed: string | null; summary: string } | null;
export function vulnerableInstall(cmd: string, lookup: VulnLookup): FamilyHit | null;
```

The command-position split that `installsIn` already does moves here and `security.ts` imports it back. `vulnerable_install` joins `RuleId`, `RuleModes` (optional, as the M12.5 fields are — an older policy cache has no such key), `DEFAULT_MODES` as `ask`, `FAMILY_RULES` and `FAMILY_REASON`, and `RulesConfig` / `DEFAULT_CONFIG.rules` / `validate().rules`. `familyHitsBash(cmd, home, toplevel, lookup?)` takes an optional fourth argument; without it the family yields nothing, so every existing test and the offline shim are unchanged. `guardBash`'s `ctx` gains `knownVulnerable?: VulnLookup`, which the store sets in `rewriteCtx()` from one prepared statement:

```sql
SELECT a.id, a.severity, a.summary, p.ranges, p.versions, p.fixed
FROM advisory_packages p JOIN advisories a ON a.id = p.advisory_id
WHERE p.ecosystem = ? AND p.name = ?
```

followed by `inRange` in memory, worst severity first. That is an indexed point read on a table of at most a few thousand rows — the same order as `heldWorktrees()` on the same path — and never a fetch. The family is inert until the advisory table has rows, so it costs nothing for a user who never enables advisories. `securityScan` takes the same optional lookup, so Activity's "what the rules would catch" counts it, and `rules dryrun` inherits it through `evaluateTool`. In the offline shim (`policy.cache.json`) there is no lookup, so the family fails open (OQ-36).

## M14.6 — `swarm security`

```
swarm security stack       [--project <name|path>] [--json]
swarm security advisories  [--project] [--min <severity>] [--all] [--json]
swarm security news        [--project] [--kind vendor,press] [--days 7] [--unread] [--json]
swarm security feeds ls    [--json]
swarm security feeds check [url] [--json]      # one URL, or every configured source when omitted; exit 1 if any is `none`
swarm security report      [--project] [--days 7] [--json]
swarm security refresh     [stack|news|advisories]
```

`advisories` while off prints the two TOML lines and the one-sentence privacy note, exit 0. `feeds check` prints `rss 24 items`, `atom 12 items` or `none: <note>` per source. `report` prints markdown, one section per project — **Stack** (totals by ecosystem and scope, manifests, scanned when), **Advisories** (a table by severity, or the off line), **Activity** (14 days from the existing scan: commands, hosts, installs, credential files, what each rule would catch), **News** (items matched in the window, with the keyword set that matched them) — so it can be pasted into an issue or a hand-off. `swarm doctor` gains one line: `security: stack 4 projects / 1,912 packages · advisories off · news 27 feeds on, 1 error`. `--json` returns the route payloads unchanged.

## M14.7 — Docs, privacy, release

This doc flips to `living`; `docs/13-config.md` gains the `[security]` block below and `rules.vulnerable_install`; `08-interface.md` the nav entry and the routes; `09-features.md` a Guard paragraph; the user guide gets a rewritten Security section in `12-observatory.md` and a new `13-security.md`; `10-privacy-and-faq.md` lists the feed hosts beside the price fetch as the outbound requests Swarm makes on its own, states the opt-in OSV query in the sentence above, and says `SWARM_OFFLINE=1` disables all fetching. Then the CHANGELOG entry, `bun tools/version.ts 0.18.0`, and the marketing draft polished.

## Data model

All in `SCHEMA` as `CREATE TABLE IF NOT EXISTS`; no `migrate()` step and no `SCHEMA_VERSION` bump unless a back-fill appears. ISO text timestamps like every other table. The daemon remains the only writer.

```sql
-- M14.1 one row per manifest read in a project: the change cursor, so a rescan is a stat, not a parse
CREATE TABLE IF NOT EXISTS stack_manifests (
  project_id TEXT NOT NULL, manifest TEXT NOT NULL,          -- repo-relative path
  kind TEXT NOT NULL, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
  packages INTEGER NOT NULL DEFAULT 0, scanned_at TEXT NOT NULL, error TEXT,
  PRIMARY KEY (project_id, manifest));
-- M14.1 what each project runs; replaced per (project, manifest) in one transaction
CREATE TABLE IF NOT EXISTS stack_packages (
  project_id TEXT NOT NULL, manifest TEXT NOT NULL, ecosystem TEXT NOT NULL,
  name TEXT NOT NULL, version TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, manifest, ecosystem, name, version));
CREATE INDEX IF NOT EXISTS stack_packages_pkg ON stack_packages(ecosystem, name);
-- M14.4 the OSV cache
CREATE TABLE IF NOT EXISTS advisories (
  id TEXT PRIMARY KEY, aliases TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL, cvss REAL, url TEXT NOT NULL, published TEXT, modified TEXT, fetched_at TEXT NOT NULL);
-- M14.4 / M14.5 which package versions an advisory names — the table the hook reads; ranges stay JSON
-- because version comparison is not SQL's job
CREATE TABLE IF NOT EXISTS advisory_packages (
  advisory_id TEXT NOT NULL, ecosystem TEXT NOT NULL, name TEXT NOT NULL,
  ranges TEXT NOT NULL DEFAULT '[]', versions TEXT NOT NULL DEFAULT '[]', fixed TEXT,
  PRIMARY KEY (advisory_id, ecosystem, name));
CREATE INDEX IF NOT EXISTS advisory_packages_pkg ON advisory_packages(ecosystem, name);
-- M14.4 an advisory that applies to a version a project runs; incident_seq is the once-only dedupe
CREATE TABLE IF NOT EXISTS advisory_hits (
  project_id TEXT NOT NULL, advisory_id TEXT NOT NULL, ecosystem TEXT NOT NULL, name TEXT NOT NULL,
  version TEXT NOT NULL, manifest TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, resolved_at TEXT, incident_seq INTEGER, acked_at TEXT,
  PRIMARY KEY (project_id, advisory_id, ecosystem, name, version, manifest));
CREATE INDEX IF NOT EXISTS advisory_hits_open ON advisory_hits(project_id, resolved_at);
-- M14.2 / M14.3 per-source state; built-ins and config entries both live here
CREATE TABLE IF NOT EXISTS news_feeds (
  url TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,   -- builtin | config
  state TEXT NOT NULL DEFAULT 'pending',                                              -- pending | on | error | off
  format TEXT, note TEXT NOT NULL DEFAULT '', etag TEXT, last_modified TEXT,
  last_try TEXT, last_ok TEXT, items INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
-- M14.2 items, stored unfiltered so a project added later can be matched against them
CREATE TABLE IF NOT EXISTS news_items (
  key TEXT PRIMARY KEY,                                      -- normalizeUrl(url)
  feed_url TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, published TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', image TEXT, matched TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL, read_at TEXT);
CREATE INDEX IF NOT EXISTS news_items_published ON news_items(published);
CREATE INDEX IF NOT EXISTS news_items_feed ON news_items(feed_url, published);
```

Why a separate `advisory_packages`: the hook has to answer "is `left-pad@1.3.0` known vulnerable" for a version that may be in no project's stack, so `advisory_hits` cannot serve it. Why `stack_manifests`: so the 60 s rescan is a `stat` compared with a row, not a parse.

`meta` keys: `security_stack_at`, `security_news_at`, `security_news_error`, `security_news_keywords` (a hash of the sorted union set), `security_osv_at`, `security_osv_error`, `security_osv_next`.

Retention, in a `pruneSecurity()` step of the daily prune: items older than `news_days`; items of a source no longer configured, with the source row; advisories (and their packages) fetched more than 30 days ago that no hit references — an open hit keeps its advisory indefinitely, a resolved hit for 90 days; resolved hits older than 90 days. Rows of a removed project go with the project.

## Config (the block for `docs/13-config.md`)

```toml
[security]
# M14. Global only (~/.swarm/config.toml): a repo's .swarm.toml cannot add a source or switch
# advisories on for the machine. SWARM_OFFLINE=1 silences every fetch in this section.
stack = true                   # read each project's lockfiles (bun.lock, pnpm-lock.yaml, package-lock.json,
                               # yarn.lock, uv.lock, poetry.lock, requirements.txt, .github workflows) —
                               # local, read-only, never written back. The Stack tab and the keywords below.
advisories = false             # ask OSV (https://api.osv.dev) about the exact versions in the lockfiles.
                               # The query carries each dependency's ecosystem, name and version — the
                               # dependency list of your project — and nothing else. Off until you set it.
advisory_min_severity = "high" # open an incident (rule "security.advisory") at this severity or above:
                               # "critical" | "high" | "medium" | "low" | "unknown" (= everything).
                               # Lower ones still show on the Advisories tab.
news = true                    # read the security news feeds (public RSS / Atom; the request carries
                               # nothing about you). false: nothing is fetched and the News view says so.
news_days = 30                 # keep items this long (1–365)
refresh_minutes = 30           # how often feeds are re-read (10–1440). OSV: every 6 h, and after a stack change.
kinds = ["vendor", "authority", "press"]   # built-in kinds to read; add "ai" for the AI press.
                               # "vendor" / "ai" items are shown whole; "authority" / "press" only when
                               # they name a keyword of the selected project's stack (or of `keywords`).
keywords = []                  # words that make an authority / press item relevant on top of the ones
                               # derived from each project's stack, e.g. ["Tailscale", "PostgreSQL", "Okta"]
feeds_off = []                 # built-in sources to skip, by name, e.g. ["Dark Reading"]
# Your own sources, appended to the built-ins. Check one before you add it:
#   swarm security feeds check https://vendor.example/security.rss   (or the Sources panel on News)
# [[security.feeds]]
# name = "Our vendor"
# url = "https://vendor.example/security.rss"
# kind = "vendor"              # vendor | authority | press | ai (default "press")
```

And under `[rules]`:

```toml
vulnerable_install = "ask"  # M14.5: `npm i left-pad@1.3.0` / `pip install requests==2.19.0` naming an exact
                            # version with a known advisory in the local advisory table. Inert until
                            # [security] advisories = true has filled that table; never a network call.
```

## Daemon service

`packages/daemon/src/security.ts` — one `SecurityService(store, version)` constructed in `createApp` beside the team forwarder and the OTLP exporter, ticked from the daemon loop. `tick(now)` runs the three branches in order — stack (every 60 s, synchronous), news, advisories — each guarded by its own `busy` flag and backoff, each wrapped so a failure sets a `meta` error and never escapes. `status()` feeds `doctor` and the view footers; `refresh(what)` serves `POST /v1/security/refresh` and the CLI.

| Route | Answer |
|---|---|
| `GET /v1/stack?project=` | the stack report (M14.1) |
| `GET /v1/advisories?project=` | the advisory report with the `enable` block (M14.4) |
| `GET /v1/news?project=&kind=&days=&unread=&all=` | items for the selected project's keyword set (M14.2) |
| `GET /v1/news/feeds` | per-source state (M14.3) |
| `POST /v1/news/feeds/check` `{ url }` | one fetch through the poller's own parser: `{ ok, format, status, contentType, title, items, sample, note }` (M14.3) |
| `POST /v1/news/read` `{ keys?, all?, project? }` | mark read (M14.2) |
| `POST /v1/security/refresh` `{ what }` | run one branch now (M14.6) |
| `GET /v1/security?project=` | unchanged, plus the `vulnerable_install` mode and count (M14.5) |

## Dashboard, in the shape the README asks for

- `views/Security.tsx` becomes a composition: the chip tabs (`securityTab` persisted in the UI store beside the Graphs tab), and the current body moves unchanged to `views/security/Activity.tsx`. Only the open tab's `useResource` is live.
- `views/security/Stack.tsx`, `Advisories.tsx`, `SeverityBadge.tsx`, `EnableAdvisories.tsx`, with `stackColumns.tsx` and `advisoryColumns.tsx` at module scope.
- `views/News.tsx` with `views/news/useNews.ts`, `columns.tsx` (a factory taking the read handler) and `Sources.tsx`.
- `api/endpoints.ts` gains `stack`, `advisories`, `news`, `newsFeeds`; `api/actions.ts` gains `markNewsRead`, `checkFeed`, `refreshSecurity` — each re-polls, none is optimistic.
- No new CSS class (`check:classes` gates it), no new icon (`broadcast`, `copy` and the external-link glyph are in the subset), no wrapped `<svg>`, selectors return snapshot slices.

## Order of work

1. **M14.1 Stack** *(~1 PR)* — parsers + tests, tables, the 60 s scan, `/v1/stack`, the Stack tab. Useful alone: every project shows what it runs.
2. **M14.2 News** *(~1 PR)* — the module, built-in sources, the poller, `/v1/news`, the News view. Works even on a machine with no lockfiles, through `keywords`.
3. **M14.3 Sources + check** *(~1 PR)* — config entries, `feeds_off`, the check route, the Sources panel, the TOML-to-paste.
4. **M14.4 Advisories** *(~1 PR)* — the module, the opt-in fetch, the tables, the tab with its Enable card.
5. **M14.5 Act** *(~1 PR)* — the incident, the rule family, the lookup on the guard context.
6. **M14.6 CLI** *(~1 PR)* — `swarm security …`, the report, the `doctor` line.
7. **M14.7 Docs + release** *(~1 PR)* — config reference, interface, guide, privacy, CHANGELOG, version bump, marketing draft.

Stack first because the news ranking and the advisories both hang off it; news before advisories because it is on by default and needs the longest soak; the act layer last so it lands on settled tables. Each step passes the full gate (`test`, `typecheck`, `lint`, `smoke`, `docs:check`, `check:classes`) and flips its roadmap row the same turn.

## Invariants this must not break

- **Repo-agnostic.** Read-only from the project root; nothing written there; an empty folder gives an empty stack, an empty Advisories tab and a News view driven by `keywords` alone. `.swarm.toml` cannot add a source or enable advisories.
- **Hook fast path.** `vulnerable_install` is one prepared indexed read plus `inRange` in memory inside `evaluateTool`. No fetch, no file read. The 400 ms shim budget is untouched. Every fetch in this milestone runs inside `SecurityService.tick`, never in a request or hook handler.
- **No account, no telemetry.** Two new outbound destinations, both documented: the feed hosts (on by default, OQ-31) and `api.osv.dev` (opt-in, OQ-33). `SWARM_OFFLINE=1` is checked at every fetch site on every tick, not once at boot.
- **`packages/team` untouched.** Nothing from this milestone is forwarded to a team daemon in this release.
- **Schema.** New tables only, `IF NOT EXISTS`; the daemon stays the only writer.
- **Config never throws.** Every `[security]` field is clamped; a bad source entry is dropped with a warning, like a bad `[[rules.custom]]`.
- **Noise.** Authority and press matching on package names like `next` or `request` would flood the view — hence the stop-list, aliases and runtime-only rule (OQ-35), and *All items* as an explicit chip rather than the default.
- **Parser drift.** Lockfile formats move (`bun.lock` is young; poetry went from `category` to `groups`). Each parser returns what it can and the manifest row records an error instead of failing the scan; the fixtures pin the shapes verified today.

## Open questions raised here

- **OQ-31** Is the news feed on by default? — proposal: yes, with the `ai` kind off.
- **OQ-32** Should the dashboard ever write `~/.swarm/config.toml`? — proposal: no; show and copy the TOML.
- **OQ-33** What the OSV query reveals, and how it is said — **decided**: off until enabled, one sentence everywhere.
- **OQ-34** GitHub Dependabot / code-scanning / secret-scanning alerts through `gh` — proposal: a later M14.8, off by default.
- **OQ-35** Keyword derivation heuristics — proposal: ship, expose the set, tune over one release.
- **OQ-36** `vulnerable_install` when the daemon is down — proposal: fails open; a bounded set in the policy cache is a later task.

---

## Addendum — what shipped (2026-10-24)

Everything above landed the same day as ten PRs, in the cut order, each useful alone. Three tasks were added after the review and are in the roadmap as M14.8 – M14.10: the open advisories in the agent's session context (`swarm_context` too), **Upgrade** on an advisory row dispatching a fix into its own worktree, and the `secret_commit` family. What differs from the design:

- **Keywords are declared runtime packages only.** The first real run over this repository derived 151 keywords from every row, transitive helpers included, and press items matched the word `which`. Names now come from declared runtime rows (and the unscoped rows only of a manifest that declares no scope at all, a pinned `requirements.txt`); GitHub Actions rows always count. 29 keywords on the same repository, no noise rows. OQ-35 is decided on that basis and stays open for tuning.
- **The advisory cache has a packages table.** `advisory_packages` carries each advisory's ranges and explicit versions so the hook can answer for a version in no project's stack; the design's "hits" table could not serve `vulnerable_install`.
- **`/v1/context` was registered twice.** The M14.8 test found that Hono answered from the first registration (the context-waste report), so `swarm_context` had always said *nothing to report*. One handler serves both now, by the presence of `cwd`.
- **The format check is scriptable.** `swarm security feeds check` without a URL checks every configured source and exits 1 when one parses as none; the Sources panel does the same for one URL.
- **No schema version bump** was needed: every table is `CREATE TABLE IF NOT EXISTS` and nothing back-fills.
- Measured on this repository against the real services: 159 packages from 4 manifests; all 27 default sources parsed, 360 items in 30 days, 98 relevant; 19 open advisories (1 critical, 4 high, 14 medium) with fixed versions.

**2026-10-24, v0.18.1 — News as a paper (M14.11).** The table was not how anyone reads news. The News view now sets its items as a paper by default — a dateline per day, stuck to the top of the pane while the day scrolls, and under it the day's articles in tiers as a front page sets them: the first two as heroes across the width (one alone with its picture beside the text), the next three as features in a row, the rest as briefs; the pictured articles fill the big slots first. Each card is the link to the article and a click marks it read. A **Paper / Table** switch sits in the heading, and a month calendar beside the items shades the days by how many articles they hold; a day narrows both views to itself. The pictures come from the feed, or from the article's own page (`pageImage`: `og:image`, then the Twitter card; never an SVG), fetched by the daemon once per item with the same user agent as a feed read, six at a time, the first 300 KB only; `news_items.page_at` remembers that the page was asked, picture or not. `[security] pictures = false` keeps the daemon to the feeds. The nav's News entry carries a newspaper icon. Measured on this repository: 265 of 360 items pictured, 13 of 27 sources giving a picture to no item of their own.

**2026-10-24, v0.18.1 — the advisories switch (M14.12, OQ-32 decided).** Nobody wants to paste two TOML lines to flip one setting. The Advisories tab's **Turn on advisories** (and `swarm security advisories on|off`, `POST /v1/advisories/enable`) writes `~/.swarm/settings.toml`: a new config layer the daemon owns, merged below `config.toml` so a hand-written value still wins — the tab and the CLI then name the file to change instead of offering the switch. `config.toml` is never edited. The report's `enable` block carries `source` (the layer in effect) and `settingsFile`; `policy.ts` names `settings.toml` in a tamper finding. The same file takes any later switch; `withSetting` in `core/src/config.ts` renders it.
