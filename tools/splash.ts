/**
 * The desktop window's first frame: a self-contained splash shown while the daemon starts, before
 * `navigate_when_ready` swaps in the dashboard URL. No request of its own, so it works offline and
 * before anything is listening.
 *
 * It lives here rather than inline in `desktop.ts` because it draws the robot, and a hand-written
 * copy of the drawing goes stale the moment the robot changes — which is exactly what happened:
 * the splash was still showing the pre-redraw head long after every other mark had moved on.
 */
import { ART_PALETTE, artSvg, HEAD, trimArt } from "../packages/core/src/art";

/** Cell size in CSS pixels. Pixel art only stays crisp at whole-number scales. */
const CELL = 6;

export function splashHtml(): string {
  const rows = trimArt(HEAD);
  const cols = (rows[0] as string).length;
  // The mark sits at a steady brightness and a soft band of rows lifts to full and travels down
  // it, like a scan passing over the face. Staggering per row rather than per cell also lets
  // `artSvg` merge each run of one colour into a single rect.
  const art = artSvg(rows, ART_PALETTE, {
    className: "mark",
    styleOf: (_g, _x, y) => `animation-delay:${(y * 0.03).toFixed(2)}s`,
    cell: CELL,
  });
  return `<!doctype html><meta charset="utf-8"><title>Swarm</title>
<style>
  html,body{margin:0;height:100%;background:#0e1013;color:#a3e635;
    font:13px system-ui,-apple-system,sans-serif;display:grid;place-items:center;gap:0;overflow:hidden}
  .wrap{display:grid;place-items:center;gap:26px;animation:rise .5s ease-out both}
  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .mark{width:${cols * CELL}px;height:${rows.length * CELL}px;image-rendering:pixelated}
  .mark rect{animation:scan 2.6s ease-in-out infinite}
  @keyframes scan{0%,10%,100%{opacity:.78}5%{opacity:1}}
  .cap{letter-spacing:.14em;text-transform:uppercase;font-size:11px;font-weight:600;color:#7c8592;
    animation:blink 1.8s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:.5}50%{opacity:1}}
  .cap b{color:#a3e635;font-weight:700}
  @media (prefers-reduced-motion:reduce){.wrap,.mark rect,.cap{animation:none}}
</style>
<body><div class="wrap">${art}<div class="cap">starting <b>Swarm</b></div></div>
`;
}
