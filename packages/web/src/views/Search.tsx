/**
 * Search (M11.9): Swarm's own memory — handoffs, incidents, gate runs, and what sessions said.
 *
 * Never your code. Claude Code greps a repository better than any index here would, so what is
 * indexed is only the material Swarm alone holds.
 *
 * FTS5 marks matches with two control characters rather than HTML, so a snippet is split on those
 * sentinels and rendered as elements — the daemon never hands the browser markup to inject.
 */
import { useEffect, useMemo, useState } from "react";
import { get, query } from "../api/client";
import { Badge, Empty, Section } from "../components/ui";
import { ago } from "../lib/format";
import { icon } from "../lib/icon";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";

interface Hit {
  kind: string;
  ref: string;
  title: string;
  snippet: string;
  task: string | null;
  projectId: string;
  sessionId: string | null;
  ts: string;
}

const KINDS: [string, string][] = [
  ["", "All"],
  ["handoff", "Handoffs"],
  ["incident", "Incidents"],
  ["gate", "Gates"],
  ["session", "Sessions"],
];

/** The sentinels `core/memory.ts` wraps each match in. */
const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";

interface Run {
  text: string;
  mark: boolean;
}

/** Split an FTS5 snippet on its highlight sentinels into plain and highlighted runs. */
function splitSnippet(text: string): Run[] {
  const runs: Run[] = [];
  let rest = text;
  while (rest.length > 0) {
    const open = rest.indexOf(MARK_OPEN);
    if (open === -1) {
      runs.push({ text: rest, mark: false });
      break;
    }
    if (open > 0) runs.push({ text: rest.slice(0, open), mark: false });
    const close = rest.indexOf(MARK_CLOSE, open);
    if (close === -1) {
      runs.push({ text: rest.slice(open + 1), mark: true });
      break;
    }
    runs.push({ text: rest.slice(open + 1, close), mark: true });
    rest = rest.slice(close + 1);
  }
  return runs;
}

function Snippet({ text }: { text: string }) {
  const runs = useMemo(() => splitSnippet(text), [text]);
  return (
    <div className="hs">
      {runs.map((run, i) =>
        run.mark ? (
          // Runs have no identity of their own; position within one immutable snippet is stable.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional runs of one immutable string
          <mark key={i}>{run.text}</mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional runs of one immutable string
          <span key={i}>{run.text}</span>
        ),
      )}
    </div>
  );
}

export function Search() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY);
  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => byId.get(id) ?? "(removed)";
  }, [projects]);

  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  /** Null until a search has run — "type to search" is a different state from "no matches". */
  const [hits, setHits] = useState<Hit[] | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    // Debounced, and the in-flight request is aborted on the next keystroke, so a slow response for
    // an older query can never overwrite a newer one.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void get<{ hits?: Hit[] }>(
        `/v1/memory${query({ q, limit: 50, project, kind: kind || null })}`,
        controller.signal,
      )
        .then((r) => setHits(r.hits ?? []))
        .catch(() => {
          // Aborted, or the daemon is unreachable; the previous hits stay on screen.
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, kind, project]);

  return (
    <>
      <Section
        title="Search"
        hint={`Swarm's own memory${project ? ` · ${projectName(project)}` : " · all projects"} — handoffs, incidents, gates, what sessions said. Never your code.`}
      />
      <div className="srch">
        <input
          type="search"
          placeholder="pkill, login form, kind:incident git reset, task:M1.2 …"
          value={q}
          autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="chips">
        {KINDS.map(([value, label]) => (
          <button
            type="button"
            key={value || "all"}
            className={kind === value ? "chip on" : "chip"}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {hits === null ? (
        <Empty>
          Type to search. Words are AND-ed, the last one is a prefix; quote a phrase;{" "}
          <code>kind:</code> and <code>task:</code> filter.
        </Empty>
      ) : hits.length === 0 ? (
        <Empty>
          Nothing in memory matches <b>{q}</b>.
        </Empty>
      ) : (
        hits.map((hit) => {
          const session = hit.kind === "session" ? hit.ref : hit.sessionId;
          return (
            <div className="hit" key={`${hit.kind}:${hit.ref}:${hit.ts}`}>
              <div className="ht">
                <Badge>{hit.kind}</Badge>
                <b>{hit.title}</b>
                {hit.task && <span className="br">{hit.task}</span>}
                <span className="grow" />
                {!project && <span className="dim">{projectName(hit.projectId)} · </span>}
                <span className="dim">{ago(hit.ts)}</span>
                {session && (
                  <button
                    type="button"
                    className="link"
                    title="Open the session"
                    onClick={() => openSession(session)}
                  >
                    {icon("arrow-right", 12)}
                  </button>
                )}
              </div>
              <Snippet text={hit.snippet} />
            </div>
          );
        })
      )}
    </>
  );
}

const EMPTY: never[] = [];
