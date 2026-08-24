/** Re-capture the dashboard screenshots used by the README and the website (docs/art/screens).
 *  Needs a running daemon with real data and Playwright: `bunx playwright install chromium`,
 *  then `bun tools/screens.ts`. Captures at 2x; thumbs are half-size for the site carousel.
 *  Playwright is not a repo dependency — it is resolved from a global/bunx install. */
import { chromium } from "playwright";

const base = "http://127.0.0.1:7777/";
const out = `${import.meta.dir}/../docs/art/screens`;
interface Snap {
  projects: Array<{ id: string; name: string }>;
  sessions: Array<{ id: string; title?: string; projectId: string; turns: number }>;
}
const state = (await (await fetch(`${base}v1/state`)).json()) as Snap;
const swarm = state.projects.find((p) => p.name === "swarm");
if (!swarm) throw new Error("no project named swarm — adjust the script");
// richest ended session in swarm: most turns
const sessions = state.sessions
  .filter((s) => s.projectId === swarm.id && s.turns > 30)
  .sort((a, b) => b.turns - a.turns);
const sess = sessions[0];
console.log("session", sess?.id, sess?.title, sess?.turns);
const shots: Array<[string, string]> = [
  ["fleet", "view=fleet"],
  ["session", `session=${sess.id}`],
  ["board", `view=board&project=${swarm.id}`],
  ["outcomes", `view=outcomes&project=${swarm.id}`],
  ["incidents", "view=incidents"],
  ["timeline", "view=timeline"],
  ["spend", "view=spend"],
  ["stats", "view=stats"],
  ["graphs", `view=graphs&project=${swarm.id}`],
];
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1512, height: 860 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem("swarm.theme", "dark");
  localStorage.setItem("swarm.star", JSON.stringify({ since: 1, never: 1 }));
});
for (const [name, q] of shots) {
  await page.goto(`${base}?${q}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(name === "stats" || name === "session" ? 4000 : 2500);
  await page.screenshot({ path: `${out}/${name}.png`, type: "png" });
  console.log("captured", name);
}
await browser.close();
// half-size thumbs for the site carousel (sips on macOS; skip elsewhere)
if (process.platform === "darwin") {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(`${out}/thumbs`, { recursive: true });
  for (const [name] of shots)
    Bun.spawnSync(
      ["sips", "-Z", "1512", `${out}/${name}.png`, "--out", `${out}/thumbs/${name}.png`],
      { stdout: "ignore" },
    );
}
