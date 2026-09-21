/**
 * "Waiting on you": every prompt that blocks an agent, in one place, from any view.
 *
 * The dock badge and the tab title count questions asked through `swarm_ask` plus permission
 * prompts parked for the dashboard (lib/attention.ts). Those used to render only on the asking
 * session's own page, so the badge pointed at something no screen showed — and a permission card
 * lives only `[broker] interactive_wait` seconds, so by the time the session was found it was gone.
 * This panel reads the same two snapshot arrays as the badge, so the two cannot disagree; a
 * question whose session the daemon does not know is shown here and nowhere else.
 *
 * Coming back to the window with something new waiting opens the panel by itself. That is also
 * what clicking a desktop notification does, since the Tauri plugin has no click callback: the
 * click focuses the app, and the focus opens the panel.
 */
import type { InteractivePermission } from "@swarm/core/permissions";
import type { Question } from "@swarm/core/questions";
import { useEffect, useMemo, useRef } from "react";
import { Modal } from "../components/Modal";
import { icon } from "../lib/icon";
import { useSnapshot, useSnapshotStore } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { QuestionCard } from "../views/session/QuestionCard";
import { InteractivePermissionCard } from "../views/session/RunControl";

const EMPTY_QUESTIONS: Question[] = [];
const EMPTY_PERMISSIONS: InteractivePermission[] = [];

/** The ids of everything waiting, for telling a new prompt from one already seen. */
function pendingIds(): string[] {
  const s = useSnapshotStore.getState().data;
  return [
    ...(s?.permissions ?? EMPTY_PERMISSIONS).map((p) => `p:${p.id}`),
    ...(s?.questions ?? EMPTY_QUESTIONS).map((q) => `q:${q.id}`),
  ];
}

/** How many prompts are waiting — the same number the dock badge shows. */
export function useWaitingCount(): number {
  const questions = useSnapshot((s) => s?.questions.length ?? 0);
  const permissions = useSnapshot((s) => s?.permissions?.length ?? 0);
  return questions + permissions;
}

/**
 * Open the panel when the window comes back to the front with a prompt the person has not had in
 * front of them. Anything present while the window had focus counts as seen, so a prompt already
 * on screen, or one dismissed, does not reopen the panel on every alt-tab.
 */
export function useOpenWaitingOnReturn(open: () => void): void {
  const seen = useRef(new Set<string>());
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const markSeen = () => {
      if (!document.hidden && document.hasFocus())
        for (const id of pendingIds()) seen.current.add(id);
    };
    markSeen();
    const unsubscribe = useSnapshotStore.subscribe(markSeen);
    const onReturn = () => {
      if (document.hidden) return;
      const fresh = pendingIds().filter((id) => !seen.current.has(id));
      for (const id of fresh) seen.current.add(id);
      if (fresh.length > 0) openRef.current();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);
}

/** The header pill: present only while something is waiting, so it is noticed when it appears. */
export function WaitingButton({ onOpen }: { onOpen: () => void }) {
  const count = useWaitingCount();
  if (count === 0) return null;
  return (
    <button
      type="button"
      className="wait-btn"
      title="Prompts blocking an agent"
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      {icon("warning", 14)}
      {count} waiting
    </button>
  );
}

export function WaitingPanel({ onClose }: { onClose: () => void }) {
  const permissions = useSnapshot((s) => s?.permissions ?? EMPTY_PERMISSIONS);
  const questions = useSnapshot((s) => s?.questions ?? EMPTY_QUESTIONS);
  const count = permissions.length + questions.length;

  return (
    <Modal
      title="Waiting on you"
      glyph="warning"
      size="wide"
      subtitle={count === 0 ? "nothing right now" : `${count}`}
      onClose={onClose}
    >
      {count === 0 && (
        <p className="dim">No agent is waiting on an answer. New prompts show up here.</p>
      )}
      {permissions.map((p) => (
        <div className="wait-item" key={`p:${p.id}`}>
          <Source sessionId={p.sessionId} projectId={p.projectId} onOpen={onClose} />
          <InteractivePermissionCard ask={p} />
        </div>
      ))}
      {questions.map((q) => (
        <div className="wait-item" key={`q:${q.id}`}>
          <Source sessionId={q.sessionId} projectId={q.projectId} onOpen={onClose} />
          <QuestionCard q={q} />
        </div>
      ))}
    </Modal>
  );
}

/** Which session and project a prompt came from, and the way to its page. */
function Source({
  sessionId,
  projectId,
  onOpen,
}: {
  sessionId: string | null;
  projectId: string | null;
  onOpen: () => void;
}) {
  const sessions = useSnapshot((s) => s?.sessions);
  const projects = useSnapshot((s) => s?.projects);
  const openSession = useUiStore((s) => s.openSession);
  const session = useMemo(() => sessions?.find((s) => s.id === sessionId), [sessions, sessionId]);
  const project = useMemo(() => projects?.find((p) => p.id === projectId), [projects, projectId]);
  const where = project?.name ?? null;

  if (!sessionId)
    return <div className="wait-src dim">{where ?? "unknown project"} · no session recorded</div>;
  const label = session?.title ?? sessionId.slice(0, 8);
  return (
    <button
      type="button"
      className="wait-src"
      title="Open this session"
      onClick={() => {
        openSession(sessionId);
        onOpen();
      }}
    >
      <b>{label}</b>
      {where && <span className="dim"> · {where}</span>}
      {icon("arrow-right", 12)}
    </button>
  );
}
