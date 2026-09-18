/**
 * Re-capture the dashboard stills used by the README and the website's carousel
 * (`docs/art/screens/*.png`, half-size copies in `thumbs/`).
 *
 * Like tools/reel.ts it films `swarm demo`, never your real home: invented projects on their own
 * port and database, so the pictures carry no real project names, prompts or costs — nothing to
 * redact, and anyone who clones the repo can re-shoot them. Every still is the same 1512×860
 * frame at 2x, so the carousel never changes height between slides.
 *
 *   bun packages/cli/src/bin.ts demo    # once, in another terminal
 *   bun tools/screens.ts                # all stills
 *   bun tools/screens.ts board          # just one
 *
 * Chrome over its own DevTools protocol, no Playwright — same reasoning as reel.ts.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs/art/screens");
const DEMO = process.env.SWARM_DEMO_URL ?? "http://127.0.0.1:7799";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9224;
const W = 1512;
const H = 860;

interface Snap {
  projects: Array<{ id: string; name: string }>;
  sessions: Array<{ id: string; projectId: string; turns: number }>;
}
const state = (await fetch(`${DEMO}/v1/state`)
  .then((r) => r.json())
  .catch(() => null)) as Snap | null;
if (!state) {
  console.error(
    `no demo daemon on ${DEMO}.\n  start one:  bun packages/cli/src/bin.ts demo\n  (its home is ~/.swarm/demo — delete that folder to reseed)`,
  );
  process.exit(1);
}
const project = state.projects[0];
if (!project) throw new Error("the demo daemon has no projects — delete ~/.swarm/demo and rerun");
// The session view reads best on the busiest session of the project the other shots use.
const session = state.sessions
  .filter((s) => s.projectId === project.id)
  .sort((a, b) => b.turns - a.turns)[0];
if (!session) throw new Error(`the demo project ${project.name} has no sessions`);

/** Name, dashboard query, and how long to let charts finish their entry animation. */
const SHOTS: Array<[string, string, number]> = [
  ["fleet", "view=fleet", 2500],
  ["session", `session=${session.id}`, 4000],
  ["board", `view=board&project=${project.id}`, 2500],
  ["outcomes", `view=outcomes&project=${project.id}`, 2500],
  ["incidents", "view=incidents", 2500],
  ["timeline", "view=timeline", 2500],
  ["spend", "view=spend", 2500],
  ["stats", "view=stats", 4000],
];

const profile = mkdtempSync(join(tmpdir(), "swarm-screens-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const cleanup = () => {
  try {
    chrome.kill();
  } catch {}
  rmSync(profile, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

/** The page target — the browser endpoint accepts Page.* and silently does nothing (see reel.ts). */
async function target(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) {
        const pages = (await r.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = pages.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("Chrome never opened a page target on its debugging port");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data)) as {
    id?: number;
    result?: unknown;
    error?: { message?: string };
  };
  if (!msg.id || !pending.has(msg.id)) return;
  if (msg.error) console.warn(`  cdp: ${msg.error.message ?? "unknown error"}`);
  pending.get(msg.id)?.(msg.result);
  pending.delete(msg.id);
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<unknown>((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
// Dark theme and no "star us" banner, set before the first paint.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `localStorage.setItem("swarm.theme","dark");localStorage.setItem("swarm.star",JSON.stringify({since:1,never:1}));`,
});
await send("Emulation.setDeviceMetricsOverride", {
  width: W,
  height: H,
  deviceScaleFactor: 2,
  mobile: false,
});

mkdirSync(join(out, "thumbs"), { recursive: true });
const only = process.argv[2];
console.log(`capturing ${DEMO} · project ${project.name}`);
for (const [name, q, wait] of SHOTS) {
  if (only && name !== only) continue;
  await send("Page.navigate", { url: `${DEMO}/?${q}` });
  await Bun.sleep(wait);
  const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data?: string };
  if (!shot?.data) {
    console.warn(`  ${name}: no screenshot`);
    continue;
  }
  const full = join(out, `${name}.png`);
  writeFileSync(full, Buffer.from(shot.data, "base64"));
  // Half-size thumbs for the carousel; the full 2x file opens in the lightbox.
  if (process.platform === "darwin")
    Bun.spawnSync(["sips", "-Z", String(W), full, "--out", join(out, "thumbs", `${name}.png`)], {
      stdout: "ignore",
    });
  console.log(`  ${name}`);
}
ws.close();
process.exit(0);
