/**
 * Naming a path in a narrow column (M11.9).
 *
 * Neither end can simply be cut: the head is a home prefix every row shares, and the tail is the
 * filename, which is the only part worth reading. So: name first, then just enough of its directory
 * to tell it from its neighbours.
 */
import { shortPath } from "./format";

/** The filename alone. */
export function fileName(path: string): string {
  const short = shortPath(path);
  return short.split("/").pop() || short;
}

/** Up to `segments` of trailing directory, elided at the front when there is more. */
export function directoryHint(path: string, segments = 2): string {
  const parts = shortPath(path).split("/");
  parts.pop();
  if (parts.length <= segments) return parts.join("/");
  return `…/${parts.slice(-segments).join("/")}`;
}

/**
 * How much directory each path needs to be distinguishable.
 *
 * Two segments is usually enough, but three worktrees each holding a `packages/web/public/app.js`
 * render identically and the list then reads as one file listed three times. Widen the context only
 * for the rows that actually collide, and only as far as it takes to separate them.
 */
export function disambiguate(paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of paths) {
    let segments = 2;
    const labelFor = (p: string, n: number) => `${fileName(p)}|${directoryHint(p, n)}`;
    while (
      segments < 6 &&
      paths.some(
        (other) => other !== path && labelFor(other, segments) === labelFor(path, segments),
      )
    ) {
      segments++;
    }
    out.set(path, directoryHint(path, segments));
  }
  return out;
}
