import { describe, expect, test } from "bun:test";
import {
  isRelevant,
  keywordMatcher,
  normalizeUrl,
  parseFeed,
  plainText,
  stackKeywords,
} from "./newsfeed";
import { BUILTIN_FEEDS, resolveSources } from "./newsfeeds";
import type { StackRow } from "./stack";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>Example security</title>
  <item>
    <title><![CDATA[Critical flaw in &lt;b&gt;Hono&lt;/b&gt; 4.6]]></title>
    <link>https://example.com/posts/hono?utm=x#top</link>
    <pubDate>Thu, 23 Oct 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>Upgrade <a href="x">now</a>.&nbsp;A path traversal in hono/node-server.</p><img src="https://example.com/t.gif" width="1" height="1"><img src="https://example.com/pic.jpg">]]></description>
  </item>
  <item>
    <title>No link here</title>
    <guid>https://example.com/posts/guid-only</guid>
    <content:encoded>Body</content:encoded>
  </item>
  <item>
    <title>Dropped: no url</title>
    <description>x</description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom feed</title>
  <entry>
    <title>PostgreSQL 17.3 fixes CVE-2026-1</title>
    <link rel="self" href="https://example.org/self"/>
    <link rel="alternate" href="https://example.org/pg"/>
    <published>2026-10-22T08:00:00Z</published>
    <summary type="html">&lt;p&gt;Security release.&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title>Second</title>
    <link href="https://example.org/second"/>
    <updated>2026-10-21T00:00:00Z</updated>
    <content>Only updated.</content>
  </entry>
</feed>`;

describe("parseFeed", () => {
  test("RSS: cdata, entities, links or guids, dates to ISO, pictures without trackers", () => {
    const f = parseFeed(RSS);
    expect(f.format).toBe("rss");
    expect(f.title).toBe("Example security");
    expect(f.items.length).toBe(2);
    const [a, b] = f.items;
    expect(a?.title).toBe("Critical flaw in Hono 4.6");
    expect(a?.url).toBe("https://example.com/posts/hono?utm=x#top");
    expect(a?.published).toBe("2026-10-23T10:00:00.000Z");
    expect(a?.summary).toBe("Upgrade now. A path traversal in hono/node-server.");
    expect(a?.image).toBe("https://example.com/pic.jpg");
    expect(b?.url).toBe("https://example.com/posts/guid-only");
    expect(b?.published).toBe("");
  });

  test("Atom: the alternate link wins, published or updated, summary or content", () => {
    const f = parseFeed(ATOM);
    expect(f.format).toBe("atom");
    expect(f.items.map((i) => i.url)).toEqual([
      "https://example.org/pg",
      "https://example.org/second",
    ]);
    expect(f.items[0]?.summary).toBe("Security release.");
    expect(f.items[1]?.published).toBe("2026-10-21T00:00:00.000Z");
  });

  test("a page that is not a feed is none", () => {
    expect(parseFeed("<html><body><h1>Hi</h1></body></html>").format).toBe("none");
    expect(parseFeed("").items).toEqual([]);
  });

  test("plainText cuts at a word and decodes twice", () => {
    expect(plainText("&amp;lt;b&amp;gt;x&amp;lt;/b&amp;gt; y")).toBe("x y");
    expect(plainText("one two three four", 9)).toBe("one two…");
  });

  test("normalizeUrl drops query, fragment and the trailing slash, lower-cases the host", () => {
    expect(normalizeUrl("HTTPS://Example.com/A/b/?x=1#f")).toBe("https://example.com/A/b");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
  });
});

describe("keywords", () => {
  const rows: StackRow[] = [
    { ecosystem: "npm", name: "hono", version: "4.6.3", scope: "runtime", manifest: "bun.lock" },
    {
      ecosystem: "npm",
      name: "@hono/node-server",
      version: "1.0.0",
      scope: "runtime",
      manifest: "bun.lock",
    },
    { ecosystem: "npm", name: "pg", version: "8.0.0", scope: "runtime", manifest: "bun.lock" },
    { ecosystem: "npm", name: "debug", version: "4.0.0", scope: "", manifest: "bun.lock" },
    {
      ecosystem: "npm",
      name: "typescript",
      version: "5.9.2",
      scope: "development",
      manifest: "bun.lock",
    },
    { ecosystem: "npm", name: "zod", version: "3.0.0", scope: "runtime", manifest: "bun.lock" },
    { ecosystem: "npm", name: "which", version: "4.0.0", scope: "", manifest: "bun.lock" },
    { ecosystem: "PyPI", name: "django", version: "4.2.0", scope: "runtime", manifest: "uv.lock" },
    {
      ecosystem: "GitHub Actions",
      name: "actions/checkout",
      version: "4",
      scope: "",
      manifest: ".github/workflows/ci.yml",
    },
  ];

  test("stackKeywords: products, ecosystems, runtime names ≥ 4 chars, no generic words, no dev tooling", () => {
    const k = stackKeywords(rows, ["Okta"]);
    expect(k[0]).toBe("Okta");
    expect(k).toContain("Hono");
    expect(k).toContain("PostgreSQL"); // pg only through its alias
    expect(k).toContain("Django");
    expect(k).toContain("Zod"); // alias for a short name
    expect(k).toContain("npm");
    expect(k).toContain("Node.js");
    expect(k).toContain("PyPI");
    expect(k).toContain("GitHub Actions");
    expect(k).toContain("hono/node-server");
    expect(k).toContain("actions/checkout");
    expect(k).not.toContain("pg");
    expect(k).not.toContain("zod"); // three letters
    expect(k).not.toContain("debug"); // generic
    expect(k).not.toContain("which"); // transitive: the project declares runtime deps, so "" rows are out
    expect(k).not.toContain("typescript"); // development scope
    expect(k).not.toContain("TypeScript");
    expect(new Set(k.map((x) => x.toLowerCase())).size).toBe(k.length);
  });

  test("stackKeywords: a manifest with no declared scope (pinned requirements) counts its unscoped rows", () => {
    const pinned: StackRow[] = [
      {
        ecosystem: "PyPI",
        name: "fastapi",
        version: "0.120.0",
        scope: "",
        manifest: "requirements.txt",
      },
      {
        ecosystem: "PyPI",
        name: "uvicorn",
        version: "0.30.0",
        scope: "",
        manifest: "requirements.txt",
      },
      { ecosystem: "PyPI", name: "idna", version: "3.7", scope: "", manifest: "requirements.txt" },
    ];
    const k = stackKeywords(pinned);
    // the product alias comes first and the lower-case name is the same word to the matcher
    expect(k).toContain("FastAPI");
    expect(k).toContain("Uvicorn");
    expect(k.map((x) => x.toLowerCase())).not.toContain("idna");
  });

  test("keywordMatcher: whole words, any case, in keyword order, one pass", () => {
    const match = keywordMatcher(["Hono", "PostgreSQL", "Next.js", "hono/node-server", "Go"]);
    expect(match("A flaw in HONO and hono/node-server; also next.js")).toEqual([
      "Hono",
      "Next.js",
      "hono/node-server",
    ]);
    expect(match("Honolulu and PostgreSQLish")).toEqual([]);
    expect(match("Let's Go!")).toEqual(["Go"]);
    expect(keywordMatcher([])("anything")).toEqual([]);
  });

  test("isRelevant: vendor and ai whole, authority and press need a keyword of the scope", () => {
    const scope = new Set(["hono", "postgresql"]);
    expect(isRelevant({ kind: "vendor", matched: [] }, scope)).toBe(true);
    expect(isRelevant({ kind: "ai", matched: [] }, scope)).toBe(true);
    expect(isRelevant({ kind: "press", matched: ["Hono"] }, scope)).toBe(true);
    expect(isRelevant({ kind: "press", matched: ["Django"] }, scope)).toBe(false);
    expect(isRelevant({ kind: "authority", matched: [] }, scope)).toBe(false);
  });
});

describe("sources", () => {
  test("built-ins are public https feeds with the four kinds", () => {
    expect(BUILTIN_FEEDS.length).toBeGreaterThan(40);
    for (const f of BUILTIN_FEEDS) {
      expect(f.url.startsWith("https://")).toBe(true);
      expect(["vendor", "authority", "press", "ai"]).toContain(f.kind);
    }
    expect(new Set(BUILTIN_FEEDS.map((f) => f.url)).size).toBe(BUILTIN_FEEDS.length);
  });

  test("resolveSources: kinds and feeds_off switch built-ins off, config feeds append or replace", () => {
    const r = resolveSources({
      kinds: ["vendor", "press"],
      feeds_off: ["dark reading"],
      feeds: [
        { name: "Ours", url: "https://vendor.example/feed", kind: "vendor" },
        {
          name: "Mine, replacing",
          url: "https://www.bleepingcomputer.com/feed/",
          kind: "authority",
        },
      ],
    });
    const by = (n: string) => r.find((f) => f.name === n);
    expect(by("Node.js vulnerability reports")?.on).toBe(true);
    expect(by("CISA advisories")?.on).toBe(false); // authority not in kinds
    expect(by("OpenAI news")?.on).toBe(false);
    expect(by("Dark Reading")?.on).toBe(false); // feeds_off, case-insensitive
    expect(by("BleepingComputer")).toBeUndefined(); // replaced by the config entry with the same url
    expect(by("Mine, replacing")).toMatchObject({ source: "config", on: true, kind: "authority" });
    expect(by("Ours")).toMatchObject({ source: "config", on: true });
  });
});
