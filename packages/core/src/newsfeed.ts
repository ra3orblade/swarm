/**
 * The security news feed (M14.2): RSS / Atom sources, read as text, ranked by what each project runs.
 *
 * Pure. The daemon fetches; this module parses a feed, decides which words make an item relevant
 * to a stack, and matches. Two ideas carry the whole thing:
 *
 * - **Kinds.** A `vendor` channel (a project's own security feed) and the `ai` press are shown
 *   whole; an `authority` (CERTs, agencies) and the `press` only when an item names a keyword.
 * - **Keywords come from the stack.** Instead of a hand-written watch list, the words are derived
 *   from the packages a project runs (`stackKeywords`), plus `[security] keywords`. Relevance then
 *   follows the lockfile and needs no upkeep. The heuristics are OQ-35.
 *
 * The parser is deliberately a regex over the text — RSS `<item>`s, then Atom `<entry>`s — because
 * every real feed tried reads with it and a malformed one still yields what it can.
 */
import type { FeedSource } from "./config";
import type { StackRow } from "./stack";

export type NewsKind = FeedSource["kind"];
export const NEWS_KINDS: readonly NewsKind[] = ["vendor", "authority", "press", "ai"];
/** Shown without a keyword match. */
export const WHOLE_KINDS: ReadonlySet<NewsKind> = new Set<NewsKind>(["vendor", "ai"]);

export interface FeedItem {
  title: string;
  url: string;
  /** ISO timestamp, or "" when the feed gave none (the daemon then uses the fetch time). */
  published: string;
  summary: string;
  image: string | null;
}

export interface ParsedFeed {
  format: "rss" | "atom" | "none";
  title: string | null;
  items: FeedItem[];
}

/** Per-source state, as `GET /v1/news/feeds` answers it. */
export interface NewsFeedState {
  name: string;
  kind: NewsKind;
  url: string;
  source: "builtin" | "config";
  state: "pending" | "on" | "error" | "off";
  format: "rss" | "atom" | "none" | null;
  note: string;
  items: number;
  lastOk: string | null;
  lastTry: string | null;
}

/** One item as the News view shows it. */
export interface NewsItemView {
  key: string;
  feed: string;
  kind: NewsKind;
  title: string;
  url: string;
  published: string;
  summary: string;
  image: string | null;
  /** The keywords of the selected scope that the item names. */
  matched: string[];
  read: boolean;
}

/** `GET /v1/news` */
export interface NewsReport {
  enabled: boolean;
  offline: boolean;
  since: string;
  days: number;
  /** The keyword set the items were narrowed with (the selected project's, or the union). */
  keywords: string[];
  counts: { shown: number; unread: number; total: number };
  items: NewsItemView[];
  feeds: { on: number; error: number; off: number };
  lastFetch: string | null;
  lastError: string | null;
}

const SUMMARY_MAX = 280;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n =
          code[1]?.toLowerCase() === "x"
            ? Number.parseInt(code.slice(2), 16)
            : Number(code.slice(1));
        return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    });
}

/** Text as a reader sees it: tags gone, entities decoded (twice, feeds double-encode), one space, cut at a word. */
export function plainText(html: string, max = SUMMARY_MAX): string {
  const text = decode(decode(html))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1") // a tag that ended right before the full stop
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/** The dedupe key of an article: lower-case scheme and host, no query, no fragment, no trailing slash. */
export function normalizeUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)/i.exec(url.trim());
  if (!m)
    return url
      .trim()
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
  return `${(m[1] as string).toLowerCase()}${(m[2] as string).replace(/\/+$/, "")}`;
}

const tag = (block: string, name: string): string => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? (m[1] as string) : "";
};
const attr = (tagText: string, name: string): string =>
  decode(new RegExp(`\\b${name}=["']([^"']+)["']`, "i").exec(tagText)?.[1] ?? "").trim();
const isoOf = (text: string): string => {
  const t = Date.parse(decode(text).trim());
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
};
const IMAGE_URL = /^https:\/\/\S+$/;

/** The picture a feed gives an item: media:content / media:thumbnail, an image enclosure, or the first real <img>. */
export function imageOf(block: string): string | null {
  const candidates: string[] = [];
  for (const m of block.matchAll(/<media:(?:content|thumbnail)\s[^>]*>/gi)) {
    const t = m[0];
    const medium = attr(t, "medium");
    const type = attr(t, "type");
    if ((!medium && !type) || medium === "image" || /^image\//i.test(type))
      candidates.push(attr(t, "url"));
  }
  for (const m of block.matchAll(/<enclosure\s[^>]*>/gi))
    if (/^image\//i.test(attr(m[0], "type"))) candidates.push(attr(m[0], "url"));
  for (const m of decode(block).matchAll(/<img\s[^>]*>/gi)) {
    const t = m[0];
    if (attr(t, "width") === "1" || attr(t, "height") === "1") continue; // a tracker pixel
    candidates.push(attr(t, "src"));
  }
  return candidates.find((u) => IMAGE_URL.test(u)) ?? null;
}

const META = /<meta\s[^>]*>/gi;
const PICTURE_META = ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"];

/**
 * The publisher's own picture for an article whose feed gave none: the Open Graph or Twitter card
 * picture the page's head names, in that order of preference. Only an https address counts, and
 * a logo drawn as SVG is not a picture of the article. The caller hands in the head of the page
 * (the first few hundred KB); a long article need not be downloaded.
 */
export function pageImage(html: string): string | null {
  const found: Record<string, string> = {};
  for (const m of String(html ?? "").matchAll(META)) {
    const t = m[0];
    const name = (attr(t, "property") || attr(t, "name")).toLowerCase();
    if (PICTURE_META.includes(name) && !found[name]) found[name] = attr(t, "content");
  }
  return (
    PICTURE_META.map((k) => found[k]).find(
      (u): u is string =>
        Boolean(u) && IMAGE_URL.test(u as string) && !/\.svg(?:[?#]|$)/i.test(u as string),
    ) ?? null
  );
}

/**
 * The items of an RSS or Atom feed, as the feed orders them, and which branch read them. A
 * malformed feed answers what can be read of it; a page that is not a feed answers `none`.
 */
export function parseFeed(xml: string): ParsedFeed {
  const text = String(xml ?? "");
  const items: FeedItem[] = [];
  for (const m of text.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = m[1] as string;
    items.push({
      title: plainText(tag(block, "title"), 300),
      url:
        decode(tag(block, "link")).trim() ||
        decode(/<guid[^>]*>([^<]*)<\/guid>/i.exec(block)?.[1] ?? "").trim(),
      published: isoOf(tag(block, "pubDate") || tag(block, "dc:date")),
      summary: plainText(tag(block, "description") || tag(block, "content:encoded")),
      image: imageOf(block),
    });
  }
  let format: ParsedFeed["format"] = items.length ? "rss" : "none";
  if (!items.length) {
    for (const m of text.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
      const block = m[1] as string;
      const links = [...block.matchAll(/<link\s[^>]*\/?>/gi)].map((l) => l[0]);
      const alternate =
        links.find((l) => /rel=["']alternate["']/i.test(l)) ??
        links.find((l) => !/rel=/i.test(l)) ??
        links[0] ??
        "";
      items.push({
        title: plainText(tag(block, "title"), 300),
        url: decode(/href=["']([^"']+)["']/i.exec(alternate)?.[1] ?? "").trim(),
        published: isoOf(tag(block, "published") || tag(block, "updated")),
        summary: plainText(tag(block, "summary") || tag(block, "content")),
        image: imageOf(block),
      });
    }
    if (items.length) format = "atom";
  }
  const kept = items.filter((i) => i.title && /^https?:\/\//.test(i.url));
  const head = text.replace(/<(item|entry)(?:\s[^>]*)?>[\s\S]*$/i, "");
  const title = plainText(tag(head, "title"), 120) || null;
  return { format: kept.length ? format : "none", title, items: kept };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A compiled matcher: the keywords a text names, as whole words, in any case, in keyword order.
 * One alternation regex, so matching an item costs one pass however long the set is.
 */
export function keywordMatcher(keywords: readonly string[]): (text: string) => string[] {
  const canon = new Map<string, string>();
  for (const k of keywords) {
    const t = k.trim();
    if (t && !canon.has(t.toLowerCase())) canon.set(t.toLowerCase(), t);
  }
  const list = [...canon.values()].sort((a, b) => b.length - a.length);
  if (!list.length) return () => [];
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${list.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  const order = new Map([...canon.values()].map((k, i) => [k.toLowerCase(), i]));
  return (text: string) => {
    const hit = new Set<string>();
    for (const m of text.matchAll(re)) {
      const k = canon.get(m[0].toLowerCase());
      if (k) hit.add(k);
    }
    return [...hit].sort(
      (a, b) => (order.get(a.toLowerCase()) ?? 0) - (order.get(b.toLowerCase()) ?? 0),
    );
  };
}

/** Whole kinds pass; the others need a keyword of the scope. */
export function isRelevant(
  item: { kind: NewsKind; matched: readonly string[] },
  keywords: ReadonlySet<string>,
): boolean {
  if (WHOLE_KINDS.has(item.kind)) return true;
  return item.matched.some((k) => keywords.has(k.toLowerCase()));
}

/** Package names that are ordinary words: as keywords they would match every other headline. */
const GENERIC_NAMES = new Set([
  "debug",
  "glob",
  "chalk",
  "commander",
  "semver",
  "uuid",
  "path",
  "util",
  "utils",
  "types",
  "test",
  "tests",
  "core",
  "common",
  "client",
  "server",
  "config",
  "cache",
  "async",
  "promise",
  "events",
  "stream",
  "buffer",
  "string",
  "object",
  "array",
  "number",
  "date",
  "time",
  "color",
  "colors",
  "image",
  "file",
  "files",
  "form",
  "forms",
  "html",
  "json",
  "yaml",
  "toml",
  "text",
  "markdown",
  "request",
  "requests",
  "response",
  "http",
  "https",
  "fetch",
  "node",
  "python",
  "shell",
  "process",
  "child",
  "parser",
  "parse",
  "format",
  "formatter",
  "logger",
  "logging",
  "error",
  "errors",
  "warning",
  "security",
  "crypto",
  "hash",
  "random",
  "math",
  "data",
  "model",
  "models",
  "schema",
  "table",
  "tables",
  "query",
  "router",
  "route",
  "routes",
  "state",
  "store",
  "redux",
  "hooks",
  "icons",
  "fonts",
  "theme",
  "style",
  "styles",
  "build",
  "bundle",
  "plugin",
  "plugins",
  "loader",
  "runner",
  "watch",
  "watcher",
  "mock",
  "mocks",
  "fixtures",
  "setup",
  "install",
  "update",
  "upgrade",
  "version",
  "release",
  "patch",
  "docs",
  "readme",
  "license",
  "example",
  "examples",
  "demo",
  "sample",
  "simple",
  "classnames",
  "lodash",
  "underscore",
  "moment",
  "dayjs",
  "pillow",
  "six",
  "attrs",
  "packaging",
  "setuptools",
  "wheel",
  "certifi",
  "idna",
  "urllib3",
  "charset-normalizer",
  "typing-extensions",
  "tslib",
  "source-map",
  "minimist",
  "yargs",
  "inquirer",
  "prettier",
  "eslint",
  "biome",
  "jest",
  "vitest",
  "mocha",
  "pytest",
  "coverage",
  "mypy",
  "ruff",
  "black",
  "flake8",
  "isort",
  "which",
  "once",
  "through",
  "inherits",
  "marked",
  "three",
  "resolve",
  "signal",
  "exit",
  "spawn",
  "open",
  "ora",
  "execa",
  "temp",
  "tmp",
  "rimraf",
  "mkdirp",
  "entities",
  "punycode",
  "argparse",
  "click",
  "rich",
  "typer",
  "tqdm",
  "colorama",
  "tabulate",
  "pyyaml",
  "toolz",
  "more-itertools",
  "python-dateutil",
  "pytz",
  "tzdata",
  "filelock",
  "platformdirs",
  "distlib",
  "virtualenv",
  "nodeenv",
  "identify",
  "cfgv",
  "pre-commit",
  "watchdog",
  "websockets",
  "anyio",
  "sniffio",
  "h11",
  "httpcore",
  "starlette",
  "itsdangerous",
  "markupsafe",
  "werkzeug",
  "blinker",
  "greenlet",
  "mako",
  "alembic",
]);

/** The product behind a package, when the press would name the product rather than the package. */
const ALIASES: Record<string, string[]> = {
  next: ["Next.js"],
  react: ["React"],
  "react-dom": ["React"],
  vue: ["Vue"],
  nuxt: ["Nuxt"],
  svelte: ["Svelte"],
  "@sveltejs/kit": ["SvelteKit"],
  "@angular/core": ["Angular"],
  angular: ["Angular"],
  pg: ["PostgreSQL"],
  postgres: ["PostgreSQL"],
  psycopg: ["PostgreSQL"],
  psycopg2: ["PostgreSQL"],
  "psycopg2-binary": ["PostgreSQL"],
  asyncpg: ["PostgreSQL"],
  mysql2: ["MySQL"],
  mysql: ["MySQL"],
  pymysql: ["MySQL"],
  mongodb: ["MongoDB"],
  mongoose: ["MongoDB"],
  pymongo: ["MongoDB"],
  redis: ["Redis"],
  ioredis: ["Redis"],
  "better-sqlite3": ["SQLite"],
  sqlite3: ["SQLite"],
  django: ["Django"],
  fastapi: ["FastAPI"],
  flask: ["Flask"],
  starlette: ["Starlette"],
  uvicorn: ["Uvicorn"],
  gunicorn: ["Gunicorn"],
  celery: ["Celery"],
  sqlalchemy: ["SQLAlchemy"],
  hono: ["Hono"],
  express: ["Express"],
  fastify: ["Fastify"],
  koa: ["Koa"],
  nestjs: ["NestJS"],
  "@nestjs/core": ["NestJS"],
  "@tauri-apps/api": ["Tauri"],
  "@tauri-apps/cli": ["Tauri"],
  electron: ["Electron"],
  vite: ["Vite"],
  webpack: ["webpack"],
  esbuild: ["esbuild"],
  prisma: ["Prisma"],
  "@prisma/client": ["Prisma"],
  drizzle: ["Drizzle"],
  "drizzle-orm": ["Drizzle"],
  typescript: ["TypeScript"],
  openai: ["OpenAI"],
  "@anthropic-ai/sdk": ["Anthropic"],
  anthropic: ["Anthropic"],
  langchain: ["LangChain"],
  "@langchain/core": ["LangChain"],
  "aws-sdk": ["AWS"],
  boto3: ["AWS"],
  botocore: ["AWS"],
  "@google-cloud/storage": ["Google Cloud"],
  "google-cloud-storage": ["Google Cloud"],
  "@azure/identity": ["Azure"],
  "azure-identity": ["Azure"],
  stripe: ["Stripe"],
  twilio: ["Twilio"],
  "@sentry/node": ["Sentry"],
  "@sentry/react": ["Sentry"],
  "@sentry/browser": ["Sentry"],
  "sentry-sdk": ["Sentry"],
  "@supabase/supabase-js": ["Supabase"],
  supabase: ["Supabase"],
  firebase: ["Firebase"],
  "firebase-admin": ["Firebase"],
  kubernetes: ["Kubernetes"],
  "@kubernetes/client-node": ["Kubernetes"],
  docker: ["Docker"],
  terraform: ["Terraform"],
  ansible: ["Ansible"],
  jsonwebtoken: ["JWT"],
  pyjwt: ["JWT"],
  jose: ["JWT"],
  passport: ["Passport"],
  "next-auth": ["NextAuth"],
  "@auth/core": ["Auth.js"],
  oauthlib: ["OAuth"],
  "python-jose": ["JWT"],
  cryptography: ["cryptography"],
  openssl: ["OpenSSL"],
  "node-forge": ["node-forge"],
  axios: ["axios"],
  httpx: ["httpx"],
  aiohttp: ["aiohttp"],
  pydantic: ["pydantic"],
  numpy: ["NumPy"],
  pandas: ["pandas"],
  torch: ["PyTorch"],
  tensorflow: ["TensorFlow"],
  transformers: ["Hugging Face"],
  "huggingface-hub": ["Hugging Face"],
  "@huggingface/inference": ["Hugging Face"],
  jinja2: ["Jinja"],
  ws: ["WebSocket"],
  "socket.io": ["Socket.IO"],
  zod: ["Zod"],
  tailwindcss: ["Tailwind"],
  bun: ["Bun"],
  "@types/bun": ["Bun"],
  deno: ["Deno"],
};

const ECOSYSTEM_WORDS: Record<StackRow["ecosystem"], string[]> = {
  npm: ["npm", "Node.js"],
  PyPI: ["PyPI", "pip", "Python"],
  "GitHub Actions": ["GitHub Actions"],
};

const MAX_KEYWORDS = 300;

/**
 * The words that make an authority / press item relevant to a stack: the ecosystems it uses, the
 * product names behind its packages, and its runtime package names (four characters or more,
 * minus the ones that are ordinary words). Development-scope packages are left out: lint tooling
 * is noise. Capped at {@link MAX_KEYWORDS}, products first.
 */
export function stackKeywords(rows: readonly StackRow[], extra: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (k: string) => {
    const t = k.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  };
  for (const k of extra) add(k);
  const ecosystems = new Set(rows.map((r) => r.ecosystem));
  // Declared runtime packages only. A lockfile's transitive rows (scope "") are hundreds of
  // helper packages with names like `which`, `once` and `through`; as keywords they matched every
  // other headline. A manifest that declares no scope at all (a pinned requirements.txt) is the one
  // case where the unscoped rows are the project's own list, so they count there.
  const declared = rows.some((r) => r.scope === "runtime");
  const candidates = rows.filter(
    (r) =>
      // a workflow's `uses:` lines are never scoped; they are the project's own choices
      r.ecosystem === "GitHub Actions" ||
      (declared ? r.scope === "runtime" : r.scope !== "development"),
  );
  for (const r of candidates) for (const a of ALIASES[r.name.toLowerCase()] ?? []) add(a);
  for (const e of ecosystems) for (const w of ECOSYSTEM_WORDS[e]) add(w);
  const names: string[] = [];
  for (const r of candidates) {
    if (r.ecosystem === "GitHub Actions") {
      names.push(r.name);
      continue;
    }
    const scoped = /^@([^/]+)\/(.+)$/.exec(r.name);
    if (scoped) {
      names.push(`${scoped[1]}/${scoped[2]}`);
      names.push(scoped[1] as string);
    } else names.push(r.name);
  }
  // runtime names before unknown-scope ones, so the cap keeps what the project declared
  const ranked = [
    ...candidates.filter((r) => r.scope === "runtime"),
    ...candidates.filter((r) => !r.scope),
  ];
  const rank = new Map<string, number>();
  ranked.forEach((r, i) => {
    if (!rank.has(r.name)) rank.set(r.name, i);
  });
  const ordered = [...new Set(names)].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
  for (const n of ordered) {
    if (out.length >= MAX_KEYWORDS) break;
    if (n.length < 4 || GENERIC_NAMES.has(n.toLowerCase())) continue;
    add(n);
  }
  return out.slice(0, MAX_KEYWORDS);
}

/** `GET /v1/news/feeds` */
export interface NewsFeedsReport {
  enabled: boolean;
  offline: boolean;
  /** `[security] kinds`: a built-in source of any other kind is off whatever `feeds_off` says. */
  kinds: NewsKind[];
  feeds: NewsFeedState[];
}

/**
 * `POST /v1/news/feeds/check`: one URL fetched once through the poller's own parser — the answer
 * to "does this source apply to the format we read". `ok` only when the format is known and at
 * least one item came back; `status` and `contentType` tell a 403 from a page that is not a feed.
 */
export interface FeedCheck {
  ok: boolean;
  url: string;
  format: ParsedFeed["format"] | null;
  status: number | null;
  contentType: string | null;
  title: string | null;
  items: number;
  sample: FeedItem[];
  note: string;
}
