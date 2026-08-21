/** Prepare the Tauri desktop app: build web assets, compile the daemon sidecar, stage resources. */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tauri = join(root, "apps/desktop/src-tauri");

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
const out = join(tauri, "binaries", `swarmd-${triple}`);
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
