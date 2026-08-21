/** Prepare the Tauri desktop app: build web assets, compile the daemon sidecar, stage resources. */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tauri = join(root, "apps/desktop/src-tauri");

// The window's frontend is a tiny splash that waits for the daemon then loads its dashboard URL.
// Generated here (not committed) so CI always has a frontendDist regardless of .gitignore.
const dist = join(root, "apps/desktop/dist");
mkdirSync(dist, { recursive: true });
Bun.write(
  join(dist, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Swarm</title>
<style>
  html,body{margin:0;height:100%;background:#0e1013;color:#a3e635;
    font:13px system-ui,-apple-system,sans-serif;display:grid;place-items:center;gap:0;overflow:hidden}
  .wrap{display:grid;place-items:center;gap:22px;animation:rise .5s ease-out both}
  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .mark rect{image-rendering:pixelated;animation:sweep 1.8s ease-in-out infinite}
  @keyframes sweep{0%,100%{opacity:.32}50%{opacity:1}}
  .cap{letter-spacing:.14em;text-transform:uppercase;font-size:11px;font-weight:600;color:#7c8592;
    animation:blink 1.8s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:.5}50%{opacity:1}}
  .cap b{color:#a3e635;font-weight:700}
</style>
<body><div class="wrap"><svg class="mark" viewBox="0 0 96 66" width="288" height="198" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="6" width="6" height="6" fill="#a3e635" style="animation-delay:0.12s"/><rect x="36" y="6" width="6" height="6" fill="#7cc02f" style="animation-delay:0.36s"/><rect x="42" y="6" width="6" height="6" fill="#7cc02f" style="animation-delay:0.42s"/><rect x="48" y="6" width="6" height="6" fill="#7cc02f" style="animation-delay:0.48s"/><rect x="54" y="6" width="6" height="6" fill="#4f7d24" style="animation-delay:0.54s"/><rect x="24" y="18" width="6" height="6" fill="#a3e635" style="animation-delay:0.24s"/><rect x="42" y="18" width="6" height="6" fill="#7cc02f" style="animation-delay:0.42s"/><rect x="48" y="18" width="6" height="6" fill="#7cc02f" style="animation-delay:0.48s"/><rect x="54" y="18" width="6" height="6" fill="#7cc02f" style="animation-delay:0.54s"/><rect x="60" y="18" width="6" height="6" fill="#7cc02f" style="animation-delay:0.6s"/><rect x="66" y="18" width="6" height="6" fill="#7cc02f" style="animation-delay:0.66s"/><rect x="72" y="18" width="6" height="6" fill="#4f7d24" style="animation-delay:0.72s"/><rect x="6" y="30" width="6" height="6" fill="#a3e635" style="animation-delay:0.06s"/><rect x="30" y="30" width="6" height="6" fill="#a3e635" style="animation-delay:0.3s"/><rect x="36" y="30" width="6" height="6" fill="#a3e635" style="animation-delay:0.36s"/><rect x="42" y="30" width="6" height="6" fill="#a3e635" style="animation-delay:0.42s"/><rect x="48" y="30" width="6" height="6" fill="#a3e635" style="animation-delay:0.48s"/><rect x="54" y="30" width="6" height="6" fill="#a3e635" style="animation-delay:0.54s"/><rect x="60" y="30" width="6" height="6" fill="#a3e635" style="animation-delay:0.6s"/><rect x="66" y="30" width="6" height="6" fill="#a3e635" style="animation-delay:0.66s"/><rect x="72" y="30" width="6" height="6" fill="#a3e635" style="animation-delay:0.72s"/><rect x="78" y="30" width="6" height="6" fill="#4f7d24" style="animation-delay:0.78s"/><rect x="24" y="42" width="6" height="6" fill="#a3e635" style="animation-delay:0.24s"/><rect x="42" y="42" width="6" height="6" fill="#7cc02f" style="animation-delay:0.42s"/><rect x="48" y="42" width="6" height="6" fill="#7cc02f" style="animation-delay:0.48s"/><rect x="54" y="42" width="6" height="6" fill="#7cc02f" style="animation-delay:0.54s"/><rect x="60" y="42" width="6" height="6" fill="#7cc02f" style="animation-delay:0.6s"/><rect x="66" y="42" width="6" height="6" fill="#4f7d24" style="animation-delay:0.66s"/><rect x="12" y="54" width="6" height="6" fill="#a3e635" style="animation-delay:0.12s"/><rect x="36" y="54" width="6" height="6" fill="#7cc02f" style="animation-delay:0.36s"/><rect x="42" y="54" width="6" height="6" fill="#7cc02f" style="animation-delay:0.42s"/><rect x="48" y="54" width="6" height="6" fill="#7cc02f" style="animation-delay:0.48s"/><rect x="54" y="54" width="6" height="6" fill="#4f7d24" style="animation-delay:0.54s"/></svg><div class="cap">starting <b>Swarm</b></div></div>
`,
);

// 1. web assets (generated: menus.js, fm.css, icons.js)
Bun.spawnSync(["bun", "run", "build:web"], { cwd: root, stdout: "inherit", stderr: "inherit" });

// 2. daemon sidecar, named for the target triple Tauri expects
const hostLine = new TextDecoder()
  .decode(Bun.spawnSync(["rustc", "-vV"]).stdout)
  .split("\n")
  .find((l) => l.startsWith("host:"));
if (!hostLine) throw new Error("could not determine the Rust host triple (is rustc installed?)");
const triple = hostLine.slice(6).trim();
mkdirSync(join(tauri, "binaries"), { recursive: true });
const out = join(tauri, "binaries", `swarmd-${triple}${triple.includes("windows") ? ".exe" : ""}`);
const r = Bun.spawnSync(
  ["bun", "build", "packages/daemon/src/bin.ts", "--compile", "--outfile", out],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (r.exitCode !== 0) process.exit(r.exitCode);

// 3. stage web assets as a Tauri resource
const web = join(tauri, "web");
rmSync(web, { recursive: true, force: true });
mkdirSync(web, { recursive: true });
cpSync(join(root, "packages/web/public"), web, { recursive: true });

console.log(`\nstaged sidecar swarmd-${triple} + web resources → ${tauri}`);

// --bundle: map Brainstorm/electron-builder signing vars to Tauri's names, then build the app.
if (process.argv.includes("--bundle")) {
  const e = process.env;
  const map: Record<string, string | undefined> = {
    // Developer ID cert (base64 .p12 + password): CSC_* / MAC_CSC_* → Tauri
    APPLE_CERTIFICATE: e.APPLE_CERTIFICATE ?? e.MAC_CSC_LINK ?? e.CSC_LINK,
    APPLE_CERTIFICATE_PASSWORD:
      e.APPLE_CERTIFICATE_PASSWORD ?? e.MAC_CSC_KEY_PASSWORD ?? e.CSC_KEY_PASSWORD,
    // notarization via Apple ID (app-specific password): APPLE_APP_SPECIFIC_PASSWORD → APPLE_PASSWORD
    APPLE_PASSWORD: e.APPLE_PASSWORD ?? e.APPLE_APP_SPECIFIC_PASSWORD,
    // pass-through (same names in both worlds)
    APPLE_ID: e.APPLE_ID,
    APPLE_TEAM_ID: e.APPLE_TEAM_ID,
    APPLE_SIGNING_IDENTITY: e.APPLE_SIGNING_IDENTITY, // else Tauri auto-discovers from the keychain
    // App Store Connect API key notarization (alternative to Apple ID)
    APPLE_API_ISSUER: e.APPLE_API_ISSUER,
    APPLE_API_KEY: e.APPLE_API_KEY_ID ?? e.APPLE_API_KEY, // Tauri wants the KEY ID here
    APPLE_API_KEY_PATH:
      e.APPLE_API_KEY_PATH ?? (e.APPLE_API_KEY?.endsWith(".p8") ? e.APPLE_API_KEY : undefined),
    // Tauri updater keypair (not from Brainstorm — its own secret)
    TAURI_SIGNING_PRIVATE_KEY: e.TAURI_SIGNING_PRIVATE_KEY,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: e.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  };
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(map)) if (v) env[k] = v;
  const signing = env.APPLE_CERTIFICATE || env.APPLE_SIGNING_IDENTITY;
  console.log(
    signing
      ? "signing: Apple credentials detected → signed + notarized build"
      : "signing: none set → unsigned build (dev)",
  );
  const b = Bun.spawnSync(["bunx", "tauri", "build"], {
    cwd: join(tauri, ".."),
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(b.exitCode);
}
