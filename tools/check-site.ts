/**
 * The landing page's equivalent of `bun run check:classes`.
 *
 * A CSS selector that stops matching never errors — it just quietly stops applying, and the
 * page looks subtly wrong in a way no test catches. So: every class the markup uses must have
 * a rule behind it, and every `<use href="#...">` must point at a symbol that exists.
 *
 * The reverse direction is deliberately not checked. Plenty of rules exist for classes only
 * site.js ever adds (`.done`, `.open`, `.mine`, `.running`, `.on`), and flagging those would
 * be noise.
 *
 *   bun tools/check-site.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const src = join(root, "site", "src");
const html = readFileSync(join(src, "index.html"), "utf8");
const css = readFileSync(join(src, "site.css"), "utf8");

const problems: string[] = [];

// ── every class in the markup has a rule ────────────────────────────────────
const used = new Set<string>();
for (const m of html.matchAll(/\sclass="([^"]+)"/g))
  for (const c of m[1].trim().split(/\s+/)) used.add(c);

// Class names as they appear in a selector: `.card`, `.gal .arr.l`, `.dl .pill.primary:hover`.
const defined = new Set<string>();
for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1]);

for (const c of [...used].sort())
  if (!defined.has(c))
    problems.push(`class "${c}" is used in index.html but no rule in site.css matches it`);

// ── every <use href="#id"> points at a symbol that exists ───────────────────
const symbols = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
for (const m of html.matchAll(/<use href="#([^"]+)"/g))
  if (!symbols.has(m[1]))
    problems.push(`<use href="#${m[1]}"> has no matching <symbol> in the sprite`);

// ── every build token the page still carries is one the build knows ─────────
// A token left in the source that build-site.ts does not fill throws at build time; this
// catches the likelier mistake of a token typed slightly wrong in one of the three files.
const KNOWN = new Set(["{{INSTALL}}", "{{RULE_SHARED_TREE}}", "{{RULE_NO_VERIFY}}"]);
for (const f of ["index.html", "site.css", "site.js"])
  for (const m of readFileSync(join(src, f), "utf8").matchAll(/\{\{[A-Z_]+\}\}/g))
    if (!KNOWN.has(m[0])) problems.push(`${f} carries unknown build token ${m[0]}`);

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`\ncheck:site — ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`check:site — ${used.size} classes, ${symbols.size} icons, all accounted for`);
