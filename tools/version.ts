/** Set one version everywhere: root + npm package.json, Tauri config, Cargo.toml, daemon VERSION —
 *  and draft the release announcement (docs/marketing/v<ver>-x.md) from the CHANGELOG entry.
 *  Usage: bun tools/version.ts 0.3.0   (then: git commit, git tag v0.3.0, git push --tags) */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Refuse to bump without release notes, before touching any file.
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const entry = changelog.match(
  new RegExp(
    `^## \\[${v.replace(/\./g, "\\.")}\\][^\n]*\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`,
    "m",
  ),
)?.[1];
if (!entry) {
  console.error(`CHANGELOG.md has no "## [${v}]" entry — write the release notes first.`);
  process.exit(2);
}
console.log(`version → ${v}`);
edit("package.json", jsonVersion);
edit("npm/package.json", jsonVersion);
edit("apps/desktop/src-tauri/tauri.conf.json", jsonVersion);
edit("apps/desktop/src-tauri/Cargo.toml", (s) =>
  s.replace(/^version = "[^"]+"/m, `version = "${v}"`),
);
edit("packages/daemon/src/app.ts", (s) => s.replace(/(VERSION = [^;]*?)"[^"]+"/, `$1"${v}"`));
// keep Cargo.lock in sync without needing cargo: only the swarm-desktop entry
edit("apps/desktop/src-tauri/Cargo.lock", (s) =>
  s.replace(/(name = "swarm-desktop"\nversion = ")[^"]+"/, `$1${v}"`),
);

// ── Release announcement ────────────────────────────────────────────────────────
// Every release gets a draft X post under docs/marketing/, generated from the CHANGELOG
// entry for this version. It is a draft: polish the hook before posting. Refuses to run
// without a CHANGELOG entry so a release can't ship unannounced.
const para =
  entry
    .split("\n")
    .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("-"))
    ?.trim() ?? "";
const bullets = [...entry.matchAll(/^- \*\*([^*]+)\*\*\s*—\s*([^\n]*)/gm)].map((m) => ({
  name: (m[1] ?? "").trim(),
  blurb: (m[2] ?? "").split(/\.\s/)[0]?.replace(/[`*]/g, "").trim() ?? "",
}));
const top = bullets.slice(0, 4);
const strip = (s: string) => s.replace(/[`*]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
const post = `Swarm v${v} is out.

${strip(para)}

${top.map((b) => `→ ${b.name}: ${b.blurb}`).join("\n")}

Local-first, open source, no account. One command:
bunx @ra3orblade/swarm setup

Release notes: https://getswarm.vercel.app/changelog
Downloads: https://getswarm.vercel.app/#downloads`;
const date = new Date().toISOString().slice(0, 10);
const mkPath = join(root, "docs", "marketing");
mkdirSync(mkPath, { recursive: true });
const mkFile = join(mkPath, `v${v}-x.md`);
if (!existsSync(mkFile)) {
  writeFileSync(
    mkFile,
    `# X post — v${v}\n\nStatus: draft (generated ${date} by tools/version.ts from CHANGELOG.md; polish before posting, then flip to "posted" with the link).\n\n---\n\n${post}\n\n---\n\n## Thread (optional follow-ups)\n\n${bullets
      .slice(4)
      .map((b) => `- ${b.name}: ${b.blurb}`)
      .join("\n")}\n`,
  );
  console.log(`  docs/marketing/v${v}-x.md (draft X post)`);
} else {
  console.log(`  docs/marketing/v${v}-x.md already exists — left untouched`);
}
