/** Set one version everywhere: root + npm package.json, Tauri config, Cargo.toml, daemon VERSION.
 *  Usage: bun tools/version.ts 0.3.0   (then: git commit, git tag v0.3.0, git push --tags) */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const v = process.argv[2];
if (!v || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) {
  console.error("usage: bun tools/version.ts <semver>");
  process.exit(2);
}
const root = join(import.meta.dir, "..");
const edit = (rel: string, fn: (s: string) => string) => {
  const p = join(root, rel);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`no version field matched in ${rel}`);
  writeFileSync(p, after);
  console.log(`  ${rel}`);
};
const jsonVersion = (s: string) => s.replace(/"version": "[^"]+"/, `"version": "${v}"`);

console.log(`version → ${v}`);
edit("package.json", jsonVersion);
edit("npm/package.json", jsonVersion);
edit("apps/desktop/src-tauri/tauri.conf.json", jsonVersion);
edit("apps/desktop/src-tauri/Cargo.toml", (s) =>
  s.replace(/^version = "[^"]+"/m, `version = "${v}"`),
);
edit("packages/daemon/src/app.ts", (s) => s.replace(/VERSION = "[^"]+"/, `VERSION = "${v}"`));
// keep Cargo.lock in sync without needing cargo: only the swarm-desktop entry
edit("apps/desktop/src-tauri/Cargo.lock", (s) =>
  s.replace(/(name = "swarm-desktop"\nversion = ")[^"]+"/, `$1${v}"`),
);
