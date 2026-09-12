/**
 * Codify (M4.3, restored in M13.6 with Apply): an incident turned into a `.swarm.toml` rule and a
 * one-line lesson for CLAUDE.md. Copy either, or press Apply and the daemon writes them on a
 * `swarm/codify-<seq>` branch in a task-less worktree, commits, and opens the PR — the main
 * checkout is never touched, and nothing is written unless this button was pressed.
 */
import type { IncidentEvent } from "@swarm/core/dashboard";
import type { LessonSuggestion } from "@swarm/core/lessons";
import { useState } from "react";
import { applyCodify, type CodifyApplied } from "../../api/actions";
import { Modal } from "../../components/Modal";
import { copyText } from "../../lib/copy";

type Target = "claude-md" | "swarm-toml" | "both";

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="mini-act"
      onClick={async () => {
        setDone(await copyText(text));
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function CodifyModal({
  incident,
  onClose,
}: {
  incident: IncidentEvent & { suggestion?: LessonSuggestion };
  onClose: () => void;
}) {
  const s = incident.suggestion;
  const [target, setTarget] = useState<Target>(s?.toml ? "both" : "claude-md");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CodifyApplied | null>(null);
  const rule = typeof incident.rule === "string" ? incident.rule : "rule";

  const apply = async () => {
    if (!incident.projectId || busy) return;
    setBusy(true);
    setResult(await applyCodify(incident.seq, incident.projectId, target));
    setBusy(false);
  };

  return (
    <Modal
      title="Codify"
      glyph="book-open"
      subtitle={`${rule} · incident #${incident.seq}`}
      onClose={onClose}
      footer={
        result?.ok ? (
          <span className="dim">
            {result.pr ? (
              <>
                PR opened:{" "}
                <a className="link" href={result.pr.url} target="_blank" rel="noreferrer">
                  {result.pr.url}
                </a>
              </>
            ) : (
              <>
                committed on <span className="br">{result.branch}</span> — no forge remote, push it
                yourself: <code>{result.gitLine}</code>
              </>
            )}
          </span>
        ) : (
          <>
            {s?.toml && (
              <span className="chips">
                {(["both", "claude-md", "swarm-toml"] as Target[]).map((t) => (
                  <button
                    type="button"
                    key={t}
                    className={target === t ? "chip on" : "chip"}
                    onClick={() => setTarget(t)}
                  >
                    {t === "both" ? "both files" : t === "claude-md" ? "CLAUDE.md" : ".swarm.toml"}
                  </button>
                ))}
              </span>
            )}
            <button
              type="button"
              className="mini-act"
              disabled={busy || !incident.projectId}
              title="Branch, commit and open a PR with these changes — the main checkout is never touched"
              onClick={() => void apply()}
            >
              {busy ? "Applying…" : "Apply → PR"}
            </button>
            {result && !result.ok && <span className="dim">{result.error}</span>}
          </>
        )
      }
    >
      {s ? (
        <>
          <p>
            <b>{s.title}</b>
          </p>
          <p className="dim">CLAUDE.md lesson</p>
          <pre className="mono">{s.lesson}</pre>
          <CopyButton text={s.lesson} />
          {s.toml ? (
            <>
              <p className="dim">.swarm.toml</p>
              <pre className="mono">{s.toml}</pre>
              <CopyButton text={s.toml} />
            </>
          ) : (
            <p className="dim">This rule has no config form; only the lesson can be written.</p>
          )}
        </>
      ) : (
        <p className="dim">Nothing to codify for this incident.</p>
      )}
    </Modal>
  );
}
