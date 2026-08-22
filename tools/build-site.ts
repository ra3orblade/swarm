/** Render docs/ + CHANGELOG.md into the static website (site/).
 *  docs/guide/*.md  → site/docs/<slug>.html          (user guide — the site's "Docs")
 *  docs/*.md        → site/docs/design/<slug>.html   (design docs — "Internals")
 *  CHANGELOG.md     → site/changelog.html.  All output is gitignored.
 *  Usage: bun run site:build   (then: bun run site:deploy) */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { marked } from "marked";

const root = join(import.meta.dir, "..");
const docsDir = join(root, "docs");
const outDir = join(root, "site", "docs");
// Screenshots: the README's docs/art/screens/*.jpg, served at /screens/ (gitignored in site/).
{
  const src = join(root, "docs", "art", "screens");
  const dst = join(root, "site", "screens");
  mkdirSync(dst, { recursive: true });
  mkdirSync(join(dst, "thumbs"), { recursive: true });
  for (const f of readdirSync(src))
    if (/\.(jpe?g|png|webp)$/i.test(f)) copyFileSync(join(src, f), join(dst, f));
  for (const f of readdirSync(join(src, "thumbs")))
    if (/\.(jpe?g|png|webp)$/i.test(f))
      copyFileSync(join(src, "thumbs", f), join(dst, "thumbs", f));
}
const REPO = "https://github.com/ra3orblade/swarm";
const SITE = "https://getswarm.vercel.app";

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** NN-slug.md → { slug, title, status, body } in numeric order. */
type Doc = { file: string; slug: string; title: string; status: string; body: string };
const loadDocs = (dir: string): Doc[] =>
  readdirSync(dir)
    .filter((f) => /^\d\d-.*\.md$/.test(f))
    .sort()
    .map((file) => {
      const src = readFileSync(join(dir, file), "utf8");
      const lines = src.split("\n");
      const title = (lines[0] ?? "").replace(/^#\s*/, "").replace(/^\d\d\s*·\s*/, "") || file;
      const statusLine = lines.find((l) => /^Status:/i.test(l)) ?? "";
      const status =
        statusLine
          .replace(/^Status:\s*/i, "")
          .split(/[.(]/)[0]
          ?.trim() ?? "";
      const body = lines.slice(1).join("\n");
      return { file, slug: basename(file, ".md"), title, status, body };
    })
    .filter((d) => d.slug !== "00-index");
const guide = loadDocs(join(docsDir, "guide"));
const design = loadDocs(docsDir);

/** Rewrite links: NN-x.md → NN-x.html; ../FOO.md → GitHub blob. */
const rewriteLinks = (html: string, base: "guide" | "design" | "root") =>
  html
    .replace(
      /href="(\d\d-[\w-]+)\.md(#[^"]*)?"/g,
      (_m, s, h) => `href="/docs/${base === "design" ? "design/" : ""}${s}${h ?? ""}"`,
    )
    .replace(/href="\.\.\/([\w./-]+)"/g, (_m, p) => `href="${REPO}/blob/main/${p}"`)
    .replace(
      /href="(?!https?:|#|\/|mailto:)([\w./-]+\.md)"/g,
      (_m, p) =>
        `href="${REPO}/blob/main/${base === "design" ? "docs/" : base === "guide" ? "docs/guide/" : ""}${p}"`,
    );

const md = (src: string) => marked.parse(src, { gfm: true, async: false }) as string;

const css = `
  :root{--bg:#0c0e12;--panel:#14171d;--panel-2:#1a1e26;--line:#242932;--line-2:#1e222a;--fg:#e6e9ee;--fg-2:#c2c8d0;--dim:#7c8592;--faint:#5a626e;
    --acc:#a3e635;--acc-soft:rgba(163,230,53,.14);--acc-contrast:#0e1013;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--r:9px;--r-sm:6px}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 var(--sans);-webkit-font-smoothing:antialiased}
  a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
  .wrap{max-width:1120px;margin:0 auto;padding:0 24px}
  header{padding:18px 0;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line-2)}
  header .mark{width:26px;image-rendering:pixelated}
  header b{font-size:16px;letter-spacing:.02em}header b a{color:var(--fg)}
  header nav{margin-left:auto;display:flex;gap:18px;font-size:14px}
  header nav a{color:var(--fg-2)}header nav a:hover,header nav a.on{color:var(--acc);text-decoration:none}
  .layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:40px;padding:32px 0 64px}
  @media (max-width:820px){.layout{grid-template-columns:1fr;gap:24px}}
  .side{font-size:14px;position:sticky;top:24px;align-self:start}
  .side h3{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:0 0 10px}
  .side a{display:block;color:var(--fg-2);padding:5px 10px;border-radius:var(--r-sm);border-left:2px solid transparent}
  .side a:hover{background:var(--panel);text-decoration:none;color:var(--fg)}
  .side a.on{color:var(--acc);background:var(--acc-soft);border-left-color:var(--acc)}
  .side a small{color:var(--faint);margin-right:6px;font-variant-numeric:tabular-nums}
  .doc{min-width:0}
  .doc h1{font-size:32px;letter-spacing:-.01em;margin:0 0 6px}
  .doc h2{font-size:22px;margin:40px 0 12px;padding-top:16px;border-top:1px solid var(--line-2)}
  .doc h3{font-size:17px;margin:28px 0 8px}.doc h4{font-size:15px;margin:20px 0 6px}
  .doc p,.doc li{color:var(--fg-2)}
  .doc .status{display:inline-block;font-size:12px;color:var(--dim);background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:2px 10px;margin:0 0 22px}
  .doc code{font:13px var(--mono);background:var(--panel-2);border:1px solid var(--line-2);border-radius:4px;padding:1px 5px;color:var(--fg)}
  .doc pre{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;overflow-x:auto}
  .doc pre{line-height:1.3;font-variant-ligatures:none}
  .doc pre code{background:none;border:0;padding:0;font-size:13px;line-height:inherit;font-family:var(--mono)}
  .doc blockquote{margin:16px 0;padding:10px 16px;border-left:3px solid var(--acc);background:var(--panel);border-radius:0 var(--r-sm) var(--r-sm) 0}
  .doc blockquote p{margin:0}
  .doc .tbl{overflow-x:auto;margin:16px 0}
  .doc table{border-collapse:collapse;width:100%;font-size:14px}
  .doc th,.doc td{border:1px solid var(--line-2);padding:7px 10px;text-align:left;vertical-align:top}
  .doc th{background:var(--panel);color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .doc td{color:var(--fg-2)}.doc tr:nth-child(even) td{background:rgba(255,255,255,.015)}
  .doc hr{border:0;border-top:1px solid var(--line-2);margin:32px 0}
  .doc img{max-width:100%}
  .doc .src{margin-top:48px;padding-top:16px;border-top:1px solid var(--line-2);font-size:13px;color:var(--faint)}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin-top:20px}
  .card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;color:var(--fg-2)}
  .card:hover{border-color:var(--acc);text-decoration:none}
  .card b{display:block;color:var(--fg);margin-bottom:4px}.card b small{color:var(--faint);margin-right:6px}
  .card span{font-size:13px;color:var(--dim)}
  footer{padding:28px 0 44px;color:var(--faint);font-size:13px;display:flex;gap:18px;flex-wrap:wrap;border-top:1px solid var(--line-2)}
  footer a{color:var(--dim)}footer a:hover{color:var(--acc)}
`;

const mark = `<svg class="mark" viewBox="0 0 96 66" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="12" y="6" width="6" height="6" fill="#a3e635"/><rect x="36" y="6" width="6" height="6" fill="#7cc02f"/><rect x="42" y="6" width="6" height="6" fill="#7cc02f"/><rect x="48" y="6" width="6" height="6" fill="#7cc02f"/><rect x="54" y="6" width="6" height="6" fill="#4f7d24"/><rect x="24" y="18" width="6" height="6" fill="#a3e635"/><rect x="42" y="18" width="6" height="6" fill="#7cc02f"/><rect x="48" y="18" width="6" height="6" fill="#7cc02f"/><rect x="54" y="18" width="6" height="6" fill="#7cc02f"/><rect x="60" y="18" width="6" height="6" fill="#7cc02f"/><rect x="66" y="18" width="6" height="6" fill="#7cc02f"/><rect x="72" y="18" width="6" height="6" fill="#4f7d24"/><rect x="6" y="30" width="6" height="6" fill="#a3e635"/><rect x="30" y="30" width="6" height="6" fill="#a3e635"/><rect x="36" y="30" width="6" height="6" fill="#a3e635"/><rect x="42" y="30" width="6" height="6" fill="#a3e635"/><rect x="48" y="30" width="6" height="6" fill="#a3e635"/><rect x="54" y="30" width="6" height="6" fill="#a3e635"/><rect x="60" y="30" width="6" height="6" fill="#a3e635"/><rect x="66" y="30" width="6" height="6" fill="#a3e635"/><rect x="72" y="30" width="6" height="6" fill="#a3e635"/><rect x="78" y="30" width="6" height="6" fill="#4f7d24"/><rect x="24" y="42" width="6" height="6" fill="#a3e635"/><rect x="42" y="42" width="6" height="6" fill="#7cc02f"/><rect x="48" y="42" width="6" height="6" fill="#7cc02f"/><rect x="54" y="42" width="6" height="6" fill="#7cc02f"/><rect x="60" y="42" width="6" height="6" fill="#7cc02f"/><rect x="66" y="42" width="6" height="6" fill="#4f7d24"/><rect x="12" y="54" width="6" height="6" fill="#a3e635"/><rect x="36" y="54" width="6" height="6" fill="#7cc02f"/><rect x="42" y="54" width="6" height="6" fill="#7cc02f"/><rect x="48" y="54" width="6" height="6" fill="#7cc02f"/><rect x="54" y="54" width="6" height="6" fill="#4f7d24"/></svg>`;

const favicon =
  readFileSync(join(root, "site", "index.html"), "utf8").match(/<link rel="icon"[^>]*>/)?.[0] ?? "";

type Page = {
  title: string;
  description: string;
  path: string;
  nav: "docs" | "changelog";
  side?: string;
  body: string;
};
const shell = (p: Page) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(p.title)} — Swarm</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(p.description)}">
<meta property="og:title" content="${esc(p.title)} — Swarm">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${SITE}/${p.path}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="google-site-verification" content="uU32AJFjQBkHR9pOl_a3olAgDNoMRF3CMn6rJ8hQiIg">
<meta name="color-scheme" content="dark">
${favicon}
<style>${css}</style>
</head>
<body>
<div class="wrap">
  <header>
    ${mark}
    <b><a href="/">Swarm</a></b>
    <nav>
      <a href="/#downloads">Downloads</a>
      <a href="/docs/"${p.nav === "docs" ? ' class="on"' : ""}>Docs</a>
      <a href="/changelog"${p.nav === "changelog" ? ' class="on"' : ""}>Changelog</a>
      <a href="${REPO}">GitHub</a>
    </nav>
  </header>
  <div class="layout"${p.side ? "" : ' style="grid-template-columns:minmax(0,1fr)"'}>
    ${p.side ? `<aside class="side">${p.side}</aside>` : ""}
    <main class="doc">${p.body}</main>
  </div>
  <footer>
    <span>Apache-2.0</span>
    <span>v${version}</span>
    <a href="${REPO}">github.com/ra3orblade/swarm</a>
    <a href="${REPO}/releases">All releases</a>
    <a href="${REPO}/issues">Issues</a>
  </footer>
</div>
<script defer src="/_vercel/insights/script.js"></script>
</body>
</html>
`;

const short = (t: string, n: number) =>
  t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, "")}…`;

const wrapTables = (html: string) =>
  html.replace(/<table>/g, '<div class="tbl"><table>').replace(/<\/table>/g, "</table></div>");

const navList = (items: Doc[], href: (d: Doc) => string, current?: string) =>
  items
    .map(
      (d) =>
        `<a href="${href(d)}"${d.slug === current ? ' class="on"' : ""}><small>${d.slug.slice(0, 2)}</small>${esc(d.title)}</a>`,
    )
    .join("");
const sideNav = (current?: string) =>
  `<h3>Guide</h3>${navList(guide, (d) => `/docs/${d.slug}`, current)}` +
  `<h3 style="margin-top:18px">Internals</h3><a href="/docs/design/">Design docs</a><a href="${REPO}/blob/main/CONTRIBUTING.md">Contributing</a><a href="/changelog">Changelog</a>`;
const designNav = (current?: string) =>
  `<h3>Design docs</h3>${navList(design, (d) => `/docs/design/${d.slug}`, current)}` +
  `<h3 style="margin-top:18px">More</h3><a href="/docs/">User guide</a><a href="${REPO}#readme">README</a><a href="/changelog">Changelog</a>`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "design"), { recursive: true });

const renderDoc = (d: Doc, kind: "guide" | "design") => {
  const dir = kind === "guide" ? "" : "design/";
  const srcPath = kind === "guide" ? `docs/guide/${d.file}` : `docs/${d.file}`;
  const html = wrapTables(rewriteLinks(md(d.body.replace(/^Status:.*$/m, "")), kind));
  const body =
    `<h1>${esc(d.title)}</h1>` +
    (kind === "design" && d.status ? `<span class="status">Status: ${esc(d.status)}</span>` : "") +
    html +
    `<p class="src">Source: <a href="${REPO}/blob/main/${srcPath}">${srcPath}</a> · v${version}.</p>`;
  writeFileSync(
    join(outDir, dir, `${d.slug}.html`),
    shell({
      title: d.title,
      description:
        kind === "guide"
          ? `Swarm guide: ${d.title}.`
          : `Swarm design doc ${d.slug.slice(0, 2)}: ${d.title}.`,
      path: `docs/${dir}${d.slug}`,
      nav: "docs",
      side: kind === "guide" ? sideNav(d.slug) : designNav(d.slug),
      body,
    }),
  );
};
for (const d of guide) renderDoc(d, "guide");
for (const d of design) renderDoc(d, "design");

// docs/index.html — the guide
const guideCards = guide
  .map((d) => {
    const blurb =
      d.body.split("\n").find((l) => l.trim() && !/^Status:/.test(l) && !l.startsWith("#")) ?? "";
    return `<a class="card" href="/docs/${d.slug}"><b><small>${d.slug.slice(0, 2)}</small>${esc(d.title)}</b><span>${esc(short(blurb.replace(/[`*[\]]/g, ""), 110))}</span></a>`;
  })
  .join("");
writeFileSync(
  join(outDir, "index.html"),
  shell({
    title: "Docs",
    description:
      "Swarm user guide: install, dashboard, rules & config, claims, runtime resources, PRs, CLI, MCP, desktop app.",
    path: "docs/",
    nav: "docs",
    side: sideNav(),
    body: `<h1>Docs</h1><p>How to install Swarm and use it day to day. Looking for how it's built? See the <a href="/docs/design/">design docs</a>.</p><div class="cards">${guideCards}</div>`,
  }),
);

// docs/design/index.html — from 00-index.md's intro + cards
const indexSrc = readFileSync(join(docsDir, "00-index.md"), "utf8");
const intro = indexSrc
  .split("\n")
  .slice(1)
  .filter((l) => !/^\|/.test(l) && !/^Status:/.test(l))
  .join("\n");
const designCards = design
  .map(
    (d) =>
      `<a class="card" href="/docs/design/${d.slug}"><b><small>${d.slug.slice(0, 2)}</small>${esc(d.title)}</b><span>${esc(d.status || "—")}</span></a>`,
  )
  .join("");
writeFileSync(
  join(outDir, "design", "index.html"),
  shell({
    title: "Design docs",
    description:
      "How Swarm is built: vision, architecture, data model, protocol, interface, roadmap.",
    path: "docs/design/",
    nav: "docs",
    side: designNav(),
    body: `<h1>Design docs</h1><p>Internal design notes — how Swarm is built and where it's going. For using it, see the <a href="/docs/">user guide</a>.</p>${rewriteLinks(md(intro), "design")}<div class="cards">${designCards}</div>`,
  }),
);

// changelog.html
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n").slice(1).join("\n");
writeFileSync(
  join(root, "site", "changelog.html"),
  shell({
    title: "Changelog",
    description: `Swarm release notes — what changed in each version, latest v${version}.`,
    path: "changelog",
    nav: "changelog",
    body: `<h1>Changelog</h1>${wrapTables(rewriteLinks(md(changelog), "root"))}<p class="src">Source: <a href="${REPO}/blob/main/CHANGELOG.md">CHANGELOG.md</a> · binaries on <a href="${REPO}/releases">GitHub Releases</a>.</p>`,
  }),
);

console.log(
  `site: ${guide.length} guide + ${design.length} design docs + changelog → site/ (v${version})`,
);
