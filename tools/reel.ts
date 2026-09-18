/**
 * The website's demo loops (`site/reel/*.webm` + `.mp4`) — the dashboard actually moving, which
 * no screenshot can show.
 *
 * It records `swarm demo`, never your real home: that daemon runs on its own port with its own
 * `~/.swarm/demo` database, seeded with two invented projects (`acme-app`, `acme-site`) and a
 * believable afternoon of agent work. So the footage is the real product with no real data in
 * it — nothing to redact, and re-recordable by anyone who clones the repo.
 *
 * No Playwright: Chrome is driven over its own DevTools protocol and `Page.startScreencast`
 * hands back the frames, which ffmpeg encodes. Both are already on a machine that builds this
 * site, and neither costs everyone else a 256-package `bun install`.
 *
 *   bun tools/reel.ts            # all clips
 *   bun tools/reel.ts fleet      # just one
 *
 * Output is two files per clip because no single format plays everywhere: VP9/webm for Chrome
 * and Firefox, h264/mp4 for Safari and iOS, which silently plays nothing when handed only webm.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "site/reel");
const DEMO = process.env.SWARM_DEMO_URL ?? "http://127.0.0.1:7799";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9223;
const W = 1280;
const FPS = 20;

/** One clip: a view to sit on, how long to film, and what to do while filming. */
interface Clip {
  name: string;
  /** Dashboard query string. `PROJECT` is replaced with the demo project's id. */
  q: string;
  seconds: number;
  caption: string;
  /**
   * Viewport height. Per clip because the seeded demo is small: filming Incidents in a 760px
   * window is two rows of content over 500px of empty panel, which reads as an unfinished app
   * rather than a quiet afternoon. Each clip gets a frame its content actually fills.
   */
  height: number;
  /**
   * Things to do while the camera runs, spread evenly across `seconds`, evaluated in the page.
   * A view that never changes emits no frames at all — Chrome only screencasts on damage — so a
   * static view needs a reason to move or it cannot be filmed.
   */
  act?: string[];
}

/** Click something by its visible text, the way a person would. Returns false if it is not there. */
const CLICK = (text: string) =>
  `(() => { const el = [...document.querySelectorAll("button, [role=button], a")].find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`;

const CLIPS: Clip[] = [
  {
    name: "fleet",
    q: "view=fleet",
    seconds: 8,
    height: 470,
    caption: "Every agent session on the machine, live — across every repository.",
    // The filter chips are the point of Fleet: one machine, many agents, narrowed on demand.
    act: [CLICK("Claude 2"), CLICK("All")],
  },
  {
    name: "board",
    q: "view=board&project=PROJECT",
    seconds: 8,
    height: 620,
    caption: "One project: tasks, claims, worktrees and the ports being held.",
  },
  {
    name: "incidents",
    q: "view=incidents",
    seconds: 7,
    height: 330,
    caption: "Every ask and deny the rules made — acknowledged once you have seen it.",
    // The story of the view in one gesture: a rule fired, you read it, you ack it, it clears.
    act: [CLICK("Ack"), CLICK("All"), CLICK("Open")],
  },
];

// ── the demo daemon ─────────────────────────────────────────────────────────
const health = await fetch(`${DEMO}/v1/health`)
  .then((r) => r.ok)
  .catch(() => false);
if (!health) {
  console.error(
    `no demo daemon on ${DEMO}.\n  start one:  bun packages/cli/src/bin.ts demo\n  (its home is ~/.swarm/demo — delete that folder to reseed)`,
  );
  process.exit(1);
}
interface Snap {
  projects: Array<{ id: string; name: string }>;
}
const state = (await (await fetch(`${DEMO}/v1/state`)).json()) as Snap;
const project = state.projects[0];
if (!project) throw new Error("the demo daemon has no projects — delete ~/.swarm/demo and rerun");
console.log(`recording ${DEMO} · project ${project.name}`);

// ── Chrome over CDP ─────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), "swarm-reel-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${Math.max(...CLIPS.map((c) => c.height))}`,
    "--force-device-scale-factor=2",
    "about:blank",
  ],
  { stdio: "ignore" },
);
// Kill the browser whatever happens next — a headless Chrome left holding a debugging port is
// the kind of stray process Swarm itself would open an incident about.
const cleanup = () => {
  try {
    chrome.kill();
  } catch {}
  rmSync(profile, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

/**
 * The *page* target, not the browser one. `/json/version` also hands out a debugger URL, but it
 * is the browser endpoint: it accepts `Page.enable` and `Page.navigate` without complaint and
 * does nothing at all with them, so the recording comes out empty with no error anywhere.
 */
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
type Handler = (params: Record<string, unknown>) => void;
const listeners = new Map<string, Handler>();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data)) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message?: string };
  };
  if (msg.id && pending.has(msg.id)) {
    // A CDP command that fails answers with `error` and no result. Swallowing that is how the
    // first version of this tool recorded three empty clips and reported success.
    if (msg.error) console.warn(`  cdp: ${msg.error.message ?? "unknown error"}`);
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
  } else if (msg.method) listeners.get(msg.method)?.(msg.params ?? {});
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<unknown>((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");
// The dashboard stores its theme and the "star us" nudge in localStorage; set both before the
// first paint so no clip opens with a dismissable banner across it.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `localStorage.setItem("swarm.theme","dark");localStorage.setItem("swarm.star",JSON.stringify({since:1,never:1}));`,
});

mkdirSync(out, { recursive: true });
const only = process.argv[2];
const made: string[] = [];

for (const clip of CLIPS) {
  if (only && clip.name !== only) continue;
  const url = `${DEMO}/?${clip.q.replace("PROJECT", project.id)}`;
  // Emulation, not a browser relaunch: the metrics override applies to the screencast too.
  await send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: clip.height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await send("Page.navigate", { url });
  await Bun.sleep(3000); // let the snapshot land and the charts finish their entry animation

  const dir = mkdtempSync(join(tmpdir(), `swarm-reel-${clip.name}-`));
  const frames: number[] = [];
  let n = 0;
  listeners.set("Page.screencastFrame", (p) => {
    const { data, sessionId } = p as { data: string; sessionId: number };
    writeFileSync(join(dir, `${String(n++).padStart(5, "0")}.jpg`), Buffer.from(data, "base64"));
    frames.push(Date.now());
    void send("Page.screencastFrameAck", { sessionId });
  });
  await send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: W * 2,
    maxHeight: clip.height * 2,
    everyNthFrame: 1,
  });
  // Space the interactions across the take, with a beat at each end so the clip does not open or
  // close mid-gesture when it loops.
  const acts = clip.act ?? [];
  const gap = (clip.seconds * 1000) / (acts.length + 1);
  await Bun.sleep(gap);
  for (const act of acts) {
    const r = (await send("Runtime.evaluate", { expression: act, returnByValue: true })) as
      | { result?: { value?: unknown } }
      | undefined;
    if (r?.result?.value === false)
      console.warn(`  ${clip.name}: nothing matched — ${act.slice(0, 60)}…`);
    await Bun.sleep(gap);
  }
  await send("Page.stopScreencast");
  listeners.delete("Page.screencastFrame");

  if (n < 2) {
    console.warn(`  ${clip.name}: only ${n} frame(s) — the view may be entirely static; skipped`);
    rmSync(dir, { recursive: true, force: true });
    continue;
  }
  // Chrome only emits a frame when something actually changed, so the sequence is uneven.
  // A constant-rate encode of it would play back at the wrong speed; the concat demuxer with a
  // real duration per frame keeps the timing the viewer saw.
  const list = frames
    .map((t, i) => {
      const next = frames[i + 1] ?? t + 1000 / FPS;
      return `file '${join(dir, `${String(i).padStart(5, "0")}.jpg`)}'\nduration ${((next - t) / 1000).toFixed(3)}`;
    })
    .join("\n");
  writeFileSync(
    join(dir, "list.txt"),
    `${list}\nfile '${join(dir, `${String(n - 1).padStart(5, "0")}.jpg`)}'\n`,
  );

  const common = ["-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt")];
  // Even dimensions or h264 refuses; -r normalises the variable input to a steady output.
  const scale = `scale=${W}:-2:flags=lanczos`;
  execFileSync(
    "ffmpeg",
    [
      ...common,
      "-vf",
      scale,
      "-r",
      String(FPS),
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "36",
      "-row-mt",
      "1",
      "-an",
      join(out, `${clip.name}.webm`),
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "ffmpeg",
    [
      ...common,
      "-vf",
      scale,
      "-r",
      String(FPS),
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "26",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      join(out, `${clip.name}.mp4`),
    ],
    { stdio: "ignore" },
  );
  // A poster: what the <video> shows before it is allowed to autoplay, and what a data-saver
  // browser shows instead of ever playing it.
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      join(out, `${clip.name}.mp4`),
      "-frames:v",
      "1",
      "-vf",
      scale,
      join(out, `${clip.name}.jpg`),
    ],
    { stdio: "ignore" },
  );
  rmSync(dir, { recursive: true, force: true });
  const kb = (f: string) => (Bun.file(join(out, f)).size / 1024) | 0;
  console.log(
    `  ${clip.name}: ${n} frames · webm ${kb(`${clip.name}.webm`)} KB · mp4 ${kb(`${clip.name}.mp4`)} KB`,
  );
  made.push(clip.name);
}

ws.close();
if (!existsSync(join(out, "captions.json")) || made.length) {
  writeFileSync(
    join(out, "captions.json"),
    `${JSON.stringify(Object.fromEntries(CLIPS.map((c) => [c.name, c.caption])), null, 2)}\n`,
  );
}
console.log(`reel: ${made.join(", ") || "nothing"} → site/reel`);
process.exit(0);
