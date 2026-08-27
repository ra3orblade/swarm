/**
 * Fail on a `className` with no rule behind it (M11).
 *
 * Twice during the React port a component was written with plausible-sounding class names — `.dot`,
 * `.proj-n`, `.kpi-v`, `.wordmark` — that the stylesheet has never had. Nothing errors: the markup
 * renders, unstyled, and the first person to notice is whoever looks at the screen. This turns that
 * into a build failure.
 *
 * It is deliberately conservative. Only string literals are checked, so a class assembled at
 * runtime is skipped rather than guessed at, and a name that appears anywhere in the stylesheet
 * counts as defined — the point is to catch names that exist nowhere, not to police specificity.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "../src");

/** Classes the stylesheet defines, plus the ones the menus island brings with it. */
function definedClasses(): Set<string> {
  const sheets = [join(srcDir, "styles/dashboard.css"), join(here, "../public/fm.css")];
  const found = new Set<string>();
  for (const sheet of sheets) {
    let css: string;
    try {
      css = readFileSync(sheet, "utf8");
    } catch {
      continue; // fm.css is generated; a clean checkout has not built it yet.
    }
    for (const m of css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) found.add(m[1] as string);
  }
  return found;
}

function* tsxFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* tsxFiles(path);
    else if (path.endsWith(".tsx")) yield path;
  }
}

/**
 * Names kept for parity with the vanilla markup that nothing styles today. Listing them is more
 * honest than deleting a hook a future rule might want.
 */
const UNSTYLED_BY_DESIGN = new Set(["lbl"]);

/**
 * Every class name written as a literal in a class *position*, with the file it came from.
 *
 * Only three positions count, because only these are reliably class names: a plain
 * `className="…"`, a template literal, and the branches of a conditional. A literal anywhere else
 * inside an expression is data — `["deny", "failed"].includes(x)` is a comparison, not a class —
 * and treating it as a class name is how a checker earns itself an ignore file.
 */
function usedClasses(): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();

  for (const file of tsxFiles(srcDir)) {
    if (file.endsWith("menus.tsx")) continue; // the island styles itself from fancy-menus
    const source = readFileSync(file, "utf8");
    const record = (literal: string) => {
      // Drop interpolations: `${tone}` is a value, not a name that can be checked.
      for (const token of literal.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)) continue;
        const where = used.get(token) ?? new Set<string>();
        where.add(file.slice(srcDir.length + 1));
        used.set(token, where);
      }
    };

    for (const attr of source.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/gs)) {
      const plain = attr[1];
      if (plain !== undefined) {
        record(plain);
        continue;
      }
      const expression = attr[2] ?? "";
      for (const tpl of expression.matchAll(/`([^`]*)`/g)) record(tpl[1] as string);
      for (const branch of expression.matchAll(/[?:]\s*"([^"]*)"/g)) record(branch[1] as string);
    }
  }
  return used;
}

const defined = definedClasses();
const unknown = [...usedClasses()].filter(
  ([name]) => !defined.has(name) && !UNSTYLED_BY_DESIGN.has(name),
);

if (unknown.length > 0) {
  console.error(`web: ${unknown.length} class name(s) with no rule in the stylesheet:\n`);
  for (const [name, files] of unknown.sort()) {
    console.error(`  .${name.padEnd(22)} ${[...files].join(", ")}`);
  }
  console.error("\nReuse the stylesheet's names, or add a rule. See packages/web/src/README.md.");
  process.exit(1);
}

console.log(`web: ${defined.size} classes defined, every className accounted for`);
