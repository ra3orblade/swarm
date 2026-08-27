/**
 * Release notes (M11.13).
 *
 * `tools/build.ts` renders `CHANGELOG.md` into `public/release-notes.js`, which assigns
 * `window.RELEASE_NOTES`. It is a plain script rather than an import because the notes change with
 * every release and bundling them would rebuild the whole dashboard to fix a typo in a changelog.
 */
export interface ReleaseNote {
  version: string;
  date?: string;
  /** Pre-rendered by tools/build.ts from our own CHANGELOG.md — not user input. */
  html: string;
}

declare global {
  interface Window {
    RELEASE_NOTES?: Record<string, { date?: string; html: string }>;
    /** Called by the desktop app's Help menu. */
    swarmWhatsNew?: ((version?: string) => void) | undefined;
  }
}

/**
 * The notes for `version`.
 *
 * `strict` is the difference between "show me the notes" and "you just upgraded". The automatic
 * post-upgrade panel must never fall back to the newest entry it happens to have: a stale cached
 * `release-notes.js` with no 0.11.0 in it once showed 0.10.0's notes under a panel triggered by
 * upgrading *to* 0.11.0, and the fallback is what hid the staleness.
 */
export function releaseNotesFor(version: string | null, strict = false): ReleaseNote | null {
  const all = window.RELEASE_NOTES ?? {};
  const exact = version ? all[version] : undefined;
  if (version && exact) return { version, ...exact };
  if (strict) return null;
  const latest = Object.keys(all)[0];
  const note = latest ? all[latest] : undefined;
  return latest && note ? { version: latest, ...note } : null;
}

const SEEN = "swarm.seenVersion";

export function markSeen(version: string): void {
  try {
    localStorage.setItem(SEEN, version);
  } catch {
    // A browser with storage denied simply sees the panel again; that is the harmless direction.
  }
}

/**
 * Which version's notes to open unprompted, or null for none.
 *
 * Never on a first run — there is nothing to compare against, and greeting someone with release
 * notes for a version they have never not had is noise.
 */
export function pendingUpgradeNotes(version: string | null): ReleaseNote | null {
  if (!version || !window.RELEASE_NOTES) return null;
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(SEEN);
  } catch {
    return null;
  }
  if (seen === version) return null;
  if (!seen) {
    markSeen(version);
    return null;
  }
  return releaseNotesFor(version, true);
}
