/** Every docs/*.md carries a Status line; every relative link resolves; index lists every doc once. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const docs = join(root, "docs");
const files = readdirSync(docs).filter((f) => f.endsWith(".md"));
let failed = false;
const fail = (m: string) => {
  failed = true;
  console.error(`✗ ${m}`);
};

const index = readFileSync(join(docs, "00-index.md"), "utf8");
for (const f of files) {
  const p = join(docs, f);
  const src = readFileSync(p, "utf8");
  if (!/^Status:/m.test(src)) fail(`${f}: no Status line`);
  if (f !== "00-index.md") {
    const n = index.split(`](${f})`).length - 1;
    if (n !== 1) fail(`00-index.md lists ${f} ${n} times`);
  }
  for (const m of src.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
    const href = m[1] ?? "";
    if (/^[a-z]+:/.test(href)) continue;
    if (!existsSync(resolve(dirname(p), href))) fail(`${f}: broken link ${href}`);
  }
}
if (failed) process.exit(1);
console.log(`docs ok (${files.length} files)`);
