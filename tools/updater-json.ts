#!/usr/bin/env bun
/**
 * Rebuild the Tauri updater manifest (`latest.json`) of a GitHub release from the assets that
 * are already on it, and print it.
 *
 *   bun tools/updater-json.ts v0.18.1 > latest.json
 *   gh release upload v0.18.1 latest.json --clobber
 *
 * Why: every leg of the `desktop` matrix in release.yml lets tauri-action merge its own platforms
 * into the manifest on the release — download, delete, upload. Two legs that finish within a
 * second of each other (0.18.1: Linux and Windows, 14:55:50 and 14:55:51) read the manifest in
 * each other's delete/upload gap, and the last upload holds one leg's platforms only; the app then
 * says "none of the fallback platforms … were found in the response `platforms` object". The
 * manifest is a pure function of the release's `.sig` assets, so the `updater-manifest` job
 * rebuilds it once, after every leg, instead of trusting the merge.
 *
 * Needs `gh` logged in with read access to the repo (the workflow's GITHUB_TOKEN is enough).
 */
import { $ } from "bun";

/** Asset name suffix → the updater platform keys tauri-action writes for it. */
const PLATFORMS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/_aarch64\.app\.tar\.gz$/, ["darwin-aarch64", "darwin-aarch64-app"]],
  [/_x64\.app\.tar\.gz$/, ["darwin-x86_64", "darwin-x86_64-app"]],
  [/_universal\.app\.tar\.gz$/, ["darwin-universal", "darwin-universal-app"]],
  [/_x64_en-US\.msi$/, ["windows-x86_64", "windows-x86_64-msi"]],
  [/_x64-setup\.exe$/, ["windows-x86_64-nsis"]],
  [/_amd64\.AppImage$/, ["linux-x86_64", "linux-x86_64-appimage"]],
  [/_amd64\.deb$/, ["linux-x86_64-deb"]],
  [/\.x86_64\.rpm$/, ["linux-x86_64-rpm"]],
];

type Asset = { name: string; url: string };
type Release = { tagName: string; body: string; createdAt: string; assets: Asset[] };

export type Manifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

/** The manifest for a release, given its assets and a reader for each `.sig` asset's text. */
export async function buildManifest(
  release: Release,
  readSig: (asset: Asset) => Promise<string>,
  now = new Date(),
): Promise<Manifest> {
  const byName = new Map(release.assets.map((a) => [a.name, a]));
  const platforms: Manifest["platforms"] = {};
  for (const sig of release.assets) {
    if (!sig.name.endsWith(".sig")) continue;
    const pkg = byName.get(sig.name.slice(0, -4));
    if (!pkg) continue;
    const keys = PLATFORMS.find(([re]) => re.test(pkg.name))?.[1];
    if (!keys) continue;
    const signature = (await readSig(sig)).trim();
    for (const k of keys) platforms[k] = { signature, url: pkg.url };
  }
  return {
    version: release.tagName.replace(/^v/, ""),
    notes: release.body,
    pub_date: now.toISOString(),
    platforms,
  };
}

if (import.meta.main) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("usage: bun tools/updater-json.ts <tag>");
    process.exit(2);
  }
  const repo = process.env.GITHUB_REPOSITORY ? ["--repo", process.env.GITHUB_REPOSITORY] : [];
  const release =
    (await $`gh release view ${tag} ${repo} --json tagName,body,createdAt,assets`.json()) as Release;
  const manifest = await buildManifest(release, async (a) => {
    // `gh release download` reads drafts too, which the asset URL does not without a token.
    const dir = `${process.env.TMPDIR ?? "/tmp"}/updater-json-${process.pid}`;
    await $`gh release download ${tag} ${repo} -p ${a.name} -D ${dir} --clobber`.quiet();
    return Bun.file(`${dir}/${a.name}`).text();
  });
  const expected = PLATFORMS.flatMap(([, keys]) => keys);
  const have = Object.keys(manifest.platforms);
  if (have.length === 0) {
    console.error(`no signed update packages on ${tag}`);
    process.exit(1);
  }
  console.error(`${tag}: ${have.length} platforms (${expected.length - have.length} not built)`);
  console.log(JSON.stringify(manifest, null, 2));
}
