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
<style>html,body{margin:0;height:100%;background:#0e1013;color:#a3e635;font:14px system-ui;display:grid;place-items:center}</style>
<body>starting Swarm…
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
