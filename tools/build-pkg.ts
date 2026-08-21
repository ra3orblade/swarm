/**
 * Build the publishable npm package (`@ra3orblade/swarm`) into ./npm:
 *   npm/dist/{swarm,swarmd,swarm-hook,swarm-mcp}.js  — one self-contained bundle per bin
 *   npm/web/                                          — dashboard assets served by swarmd
 *   npm/README.md, npm/LICENSE                        — copied from the repo root
 * Bundles target the Bun runtime (bun:sqlite stays native), so the package has zero runtime deps
 * and only needs `bun` on the machine. Run `bun run build:pkg`, then `npm publish` from ./npm.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "npm");
const dist = join(out, "dist");

const BINS = {
  swarm: "packages/cli/src/bin.ts",
  swarmd: "packages/daemon/src/bin.ts",
  "swarm-hook": "packages/hook/src/bin.ts",
  "swarm-mcp": "packages/mcp/src/bin.ts",
} as const;

// 0. generated web assets (menus.js, fm.css, icons.js)
const web = Bun.spawnSync(["bun", "run", "build:web"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (web.exitCode !== 0) process.exit(web.exitCode);

// 1. bundles
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const version = (JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as { version: string })
  .version;
for (const [name, src] of Object.entries(BINS)) {
  const target = join(dist, `${name}.js`);
  const r = await Bun.build({
    entrypoints: [join(root, src)],
    outdir: dist,
    naming: `${name}.js`,
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
    define: { "process.env.SWARM_VERSION": JSON.stringify(version) },
  });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
  let code = readFileSync(target, "utf8");
  if (!code.startsWith("#!")) code = `#!/usr/bin/env bun\n${code}`;
  writeFileSync(target, code, { mode: 0o755 });
}

// 2. web assets + docs
rmSync(join(out, "web"), { recursive: true, force: true });
cpSync(join(root, "packages/web/public"), join(out, "web"), { recursive: true });
for (const f of ["README.md", "LICENSE"]) cpSync(join(root, f), join(out, f));

console.log(`built @ra3orblade/swarm@${version} → ${out}`);
for (const name of Object.keys(BINS)) {
  const p = join(dist, `${name}.js`);
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  console.log(`  ${name}: ${(Bun.file(p).size / 1024).toFixed(0)} KB`);
}
