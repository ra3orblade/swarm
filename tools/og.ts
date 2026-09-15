/**
 * The share image (`site/og.png`, 1200x630) — what Slack, X, LinkedIn and iMessage draw when
 * someone posts a link to the site.
 *
 * It lives here because the last one was a *screenshot of the website*, taken by hand at v0.2.2
 * and never taken again: it still showed the pre-redraw robot, a version a year out of date and
 * a tagline that named three agents when six are supported. Every other mark Swarm ships is
 * generated from `core/src/art.ts` for exactly this reason (see `icons.ts`); the share image was
 * the last hand-made copy left, and it went stale the way hand-made copies do.
 *
 * So: the robot comes from the art module, the words come from the page's own <meta> tags, and
 * the colours come from the site's custom properties. Nothing here is a second copy of anything.
 *
 * Text needs a rasteriser, so this shells out to the Chrome already on the machine rather than
 * adding a 256-package browser driver to everyone's `bun install` for one 1200x630 PNG:
 *
 *   bun tools/og.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ART_PALETTE, artSvg, HEAD, trimArt } from "../packages/core/src/art";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "site");

// ── the words: read from the page, never retyped ────────────────────────────
// A share image whose headline disagrees with the page is worse than none at all, so the copy is
// lifted from the <meta> tags the page already serves. Change the tag, re-run this, done.
const html = readFileSync(join(site, "index.html"), "utf8");
const meta = (prop: string): string => {
  const m = html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`));
  if (!m) throw new Error(`no <meta property="${prop}"> in site/index.html`);
  return m[1] as string;
};
// "Swarm — see every agent, stop the collisions" → the part after the em dash, sentence-cased as
// the hero writes it. The hero's own <h1> is the authority on wording; og:title is the authority
// on what we promise a link preview.
const title = meta("og:title").replace(/^Swarm\s+—\s+/, "");
// "see every agent, stop the collisions" → "See every agent. Stop the collisions." — the hero's
// own <h1>, which writes the two halves as separate sentences.
const headline = `${title
  .split(/,\s+/)
  .map((part) => part.replace(/^./, (c) => c.toUpperCase()))
  .join(". ")}.`;
const blurb = meta("og:description");

// ── the mark: the same rows every other icon is cut from ────────────────────
const mark = artSvg(trimArt([...HEAD]), ART_PALETTE, { cell: 6, title: "Swarm" });

// Design tokens: these are the values in site/src/site.css's :root, repeated here because this
// card is rendered standalone by Chrome and never loads the site's stylesheet.
const card = `<!doctype html><meta charset="utf-8">
<style>
  @font-face { font-family: x; src: local("SF Pro Display"), local("Helvetica Neue"); }
  *{box-sizing:border-box;margin:0}
  html,body{width:1200px;height:630px}
  body{
    background:#0c0e12; color:#e6e9ee;
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
    display:flex; flex-direction:column; justify-content:center;
    padding:0 84px; position:relative; overflow:hidden;
  }
  /* the hero's rain, frozen: a faint dot grid tinted toward the accent in the top right, so the
     card reads as the same surface as the page without needing the canvas to run */
  body::before{
    content:""; position:absolute; inset:0;
    background:
      radial-gradient(760px 420px at 88% -8%, rgba(163,230,53,.10), transparent 70%),
      radial-gradient(520px 380px at 6% 108%, rgba(163,230,53,.05), transparent 70%);
  }
  body::after{
    content:""; position:absolute; inset:0; opacity:.5;
    background-image:radial-gradient(rgba(124,133,146,.22) 1px, transparent 1px);
    background-size:16px 16px;
    -webkit-mask-image:radial-gradient(900px 560px at 78% 0%, #000, transparent 72%);
  }
  .in{position:relative;z-index:1}
  .top{display:flex;align-items:center;gap:18px;margin-bottom:34px}
  .top svg{width:96px;height:auto;image-rendering:pixelated;display:block}
  .name{font-size:30px;font-weight:700;letter-spacing:-.4px}
  .name span{color:#7c8592;font-weight:500}
  h1{font-size:62px;line-height:1.08;letter-spacing:-1.8px;font-weight:700;max-width:19ch}
  p{margin-top:22px;font-size:22px;line-height:1.5;color:#c2c8d0;max-width:52ch}
  .foot{margin-top:40px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .pill{
    font:500 16px/1 ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
    color:#0e1013;background:#a3e635;border-radius:20px;padding:11px 18px;
  }
  .b{font:500 16px/1 ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;color:#7c8592;
     border:1px solid #242932;border-radius:20px;padding:10px 16px;background:#14171d}
</style>
<div class="in">
  <div class="top">${mark}<div class="name">Swarm <span>— local-first control plane for AI agents</span></div></div>
  <h1>${headline}</h1>
  <p>${blurb}</p>
  <div class="foot">
    <div class="pill">bunx @ra3orblade/swarm setup</div>
    <div class="b">Claude Code · Codex · Gemini · Grok · Aider · opencode</div>
  </div>
</div>`;

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const tmp = mkdtempSync(join(tmpdir(), "swarm-og-"));
try {
  writeFileSync(join(tmp, "card.html"), card);
  // Captured at 2x and left there: the <meta> tags promise 1200x630, and every platform that
  // re-encodes a share image downscales a sharp 2x better than it sharpens a soft 1x.
  execFileSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--window-size=1200,630",
      `--screenshot=${join(tmp, "og.png")}`,
      `file://${join(tmp, "card.html")}`,
    ],
    { stdio: "ignore", timeout: 60_000 },
  );
  const shot = readFileSync(join(tmp, "og.png"));
  writeFileSync(join(site, "og.png"), shot);
  console.log(`og.png ${(shot.length / 1024) | 0} KB → site/og.png\n  "${headline}"`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
