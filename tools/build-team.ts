/**
 * Build the team daemon for distribution (M13.13, OQ-27) into ./npm-team — kept apart from the
 * Apache-2.0 `npm/` package on purpose: `swarm-teamd` is FSL-1.1-ALv2 and ships on its own.
 *
 *   npm-team/dist/swarm-teamd.js      one self-contained bundle (Bun runtime), the npm bin
 *   npm-team/package.json             @ra3orblade/swarm-team at the release version
 *   npm-team/LICENSE.md, README.md    from packages/team
 *   npm-team/bin/swarm-teamd-<os>-<arch>[.exe] + swarm-teamd-SHA256SUMS   with --binaries: `bun build --compile`
 *                                     per platform, attached to the GitHub release; the desktop app
 *                                     downloads the one for its machine when someone chooses to host
 *
 * The team page's assets are embedded (`globalThis.__SWARM_TEAM_ASSETS`), because a compiled
 * binary has no files beside it. `bun tools/build-team.ts [--binaries]`.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEAMD_SUMS, TEAMD_TARGETS } from "../packages/core/src/teamsetup";

const root = join(import.meta.dir, "..");
const out = join(root, "npm-team");
const dist = join(out, "dist");
const version = (
  JSON.parse(readFileSync(join(root, "npm", "package.json"), "utf8")) as { version: string }
).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. the page's assets, embedded: its own index.html + app.js, and the shared viz.js it loads
const assets: Record<string, string> = {
  "index.html": readFileSync(join(root, "packages/team/public/index.html"), "utf8"),
  "app.js": readFileSync(join(root, "packages/team/public/app.js"), "utf8"),
  "viz.js": readFileSync(join(root, "packages/web/public/viz.js"), "utf8"),
};
const tmp = join(out, ".build");
mkdirSync(tmp, { recursive: true });
writeFileSync(
  join(tmp, "assets.ts"),
  `(globalThis as { __SWARM_TEAM_ASSETS?: Record<string, string> }).__SWARM_TEAM_ASSETS = ${JSON.stringify(assets)};\n`,
);
// imports evaluate in order: the assets are in place before the daemon's modules load
const entry = join(tmp, "entry.ts");
writeFileSync(
  entry,
  `import "./assets";\nimport ${JSON.stringify(join(root, "packages/team/src/bin.ts"))};\n`,
);

// 2. the npm bundle
const r = await Bun.build({
  entrypoints: [entry],
  outdir: dist,
  naming: "swarm-teamd.js",
  target: "bun",
  format: "esm",
  define: { "process.env.SWARM_VERSION": JSON.stringify(version) },
});
if (!r.success) {
  for (const l of r.logs) console.error(l);
  process.exit(1);
}
const bundle = join(dist, "swarm-teamd.js");
writeFileSync(bundle, `#!/usr/bin/env bun\n${readFileSync(bundle, "utf8")}`, { mode: 0o755 });

writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "@ra3orblade/swarm-team",
      version,
      description:
        "Swarm team daemon — the self-hosted control plane for a team of Swarm machines. Source-available (FSL-1.1-ALv2), separate from the Apache-2.0 @ra3orblade/swarm.",
      license: "FSL-1.1-ALv2",
      type: "module",
      bin: { "swarm-teamd": "dist/swarm-teamd.js" },
      files: ["dist", "LICENSE.md", "README.md"],
      engines: { bun: ">=1.1" },
      repository: { type: "git", url: "git+https://github.com/ra3orblade/swarm.git" },
      homepage: "https://getswarm.vercel.app/docs/teams",
    },
    null,
    2,
  )}\n`,
);
for (const f of ["LICENSE.md", "README.md"]) cpSync(join(root, "packages/team", f), join(out, f));
console.log(`built @ra3orblade/swarm-team@${version} → ${out}`);

// 3. per-platform binaries (release only — each is ~60 MB)
if (process.argv.includes("--binaries")) {
  const bin = join(out, "bin");
  mkdirSync(bin, { recursive: true });
  const sums: string[] = [];
  for (const t of TEAMD_TARGETS) {
    const file = join(bin, t.asset);
    const p = Bun.spawnSync(
      [
        "bun",
        "build",
        "--compile",
        `--target=${t.target}`,
        `--define=process.env.SWARM_VERSION=${JSON.stringify(version)}`,
        entry,
        "--outfile",
        file,
      ],
      { cwd: root, stdout: "inherit", stderr: "inherit" },
    );
    if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
    sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${t.asset}`);
  }
  writeFileSync(join(bin, TEAMD_SUMS), `${sums.join("\n")}\n`);
  console.log(`built ${TEAMD_TARGETS.length} swarm-teamd binaries → ${bin}`);
}
rmSync(tmp, { recursive: true, force: true });
