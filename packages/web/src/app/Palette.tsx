/**
 * The ⌘K palette (M9.1, ported in M11.13): jump to any view, project or live session, and fall
 * through to full-text search for anything else.
 *
 * Ranking is "where does the match start", not a fuzzy score. With a few dozen candidates the
 * earliest prefix match is what people mean, and a fuzzy matcher mostly buys surprising orderings.
 *
 * Idle — before anything is typed — it lists every view and project but only *live* sessions.
 * A hundred ended sessions would bury the destinations you opened it for.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { icon } from "../lib/icon";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { VIEW_DEFS } from "./views";

interface Entry {
  icon: string;
  label: string;
  /** Secondary text — a session's project. */
  sub?: string;
  group: string;
  live?: boolean;
  run: () => void;
}

const IDLE_LIMIT = 16;
const MATCH_LIMIT = 12;
const NO_MATCH = Number.POSITIVE_INFINITY;

/** How early the query appears in an entry's text. Lower is better; Infinity means no match. */
function rank(entry: Entry, query: string): number {
  return Math.min(
    ...[entry.label, entry.sub ?? ""].map((text) => {
      const at = text.toLowerCase().indexOf(query);
      return at < 0 ? NO_MATCH : at;
    }),
  );
}

export function Palette({ onClose }: { onClose: () => void }) {
  const openView = useUiStore((s) => s.openView);
  const selectProject = useUiStore((s) => s.selectProject);
  const openSession = useUiStore((s) => s.openSession);
  const setSearch = useUiStore((s) => s.setSearch);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
    return [
      ...VIEW_DEFS.map((v) => ({
        icon: v.icon,
        label: v.label,
        group: v.group.toLowerCase(),
        run: () => openView(v.id),
      })),
      ...projects.map((p) => ({
        icon: "folder-simple",
        label: p.name,
        group: "project",
        run: () => selectProject(p.id),
      })),
      ...sessions.map((s) => ({
        icon: "terminal-window",
        label: s.title ?? s.id.slice(0, 8),
        sub: projectName(s.projectId),
        live: s.state === "active" || s.state === "waiting",
        group: "session",
        run: () => openSession(s.id),
      })),
    ];
  }, [projects, sessions, openView, selectProject, openSession]);

  const shown = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.filter((e) => e.group !== "session" || e.live).slice(0, IDLE_LIMIT);
    const hits = entries
      .map((entry) => ({ entry, r: rank(entry, q) }))
      .filter((h) => h.r !== NO_MATCH)
      .sort((a, b) => a.r - b.r)
      .slice(0, MATCH_LIMIT)
      .map((h) => h.entry);
    // Always last: whatever the palette could not name, Search can still find inside sessions.
    hits.push({
      icon: "magnifying-glass",
      label: `Search Swarm for “${query.trim()}”`,
      group: "search",
      run: () => setSearch(query.trim()),
    });
    return hits;
  }, [entries, query, setSearch]);

  const index = Math.min(cursor, Math.max(0, shown.length - 1));

  // The palette exists to be typed into, so it takes focus on open. Done with a ref rather than
  // `autoFocus`, which fires on every render the attribute survives and reads as a page-load grab.
  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    list.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  });

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  return (
    // `#picker` is the backdrop; the palette goes in directly (see components/Modal).
    <div className="pk pal" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="pk-h">
        {icon("magnifying-glass", 15)}
        <input
          ref={input}
          placeholder="Jump to view, project or session…"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setCursor(Math.max(0, Math.min(shown.length - 1, index + step)));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(shown[index]);
            }
          }}
        />
      </div>
      <div className="pk-list" ref={list}>
        {shown.length === 0 ? (
          <div className="empty pal-empty">No matches.</div>
        ) : (
          shown.map((entry, i) => (
            <button
              type="button"
              key={`${entry.group}:${entry.label}`}
              className={i === index ? "pk-row on" : "pk-row"}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(entry)}
            >
              {icon(entry.icon, 14)}
              <span className="nm">
                {entry.label}
                {entry.sub && <span className="dim"> · {entry.sub}</span>}
              </span>
              <span className="grp">{entry.group}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

const EMPTY: never[] = [];
