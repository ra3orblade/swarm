/**
 * Hygiene's two actions (M11.8).
 *
 * They are deliberately separate, because they are different acts. Clearing build output keeps the
 * checkout, the branch and every uncommitted edit, so a dirty tree is fine. Removing a worktree
 * does not, so it asks the ledger first and only offers force after the ledger has refused with a
 * reason — never as the first option.
 */
import type { WorktreeHealth } from "@swarm/core/hygiene";
import { useState } from "react";
import { reclaimBuildOutput, removeWorktree, stopProcess } from "../../api/actions";
import { megabytes } from "../../lib/format";

/** Stop a registered process by pid. */
export function StopProcess({
  pid,
  projectId,
  onDone,
}: {
  pid: number;
  projectId: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="mini-act"
      title="Stop this process"
      disabled={busy}
      onClick={async () => {
        if (!confirm(`Stop pid ${pid}?`)) return;
        setBusy(true);
        const r = await stopProcess(pid, projectId);
        setBusy(false);
        if (!r.ok && r.error) alert(r.error);
        onDone();
      }}
    >
      {busy ? "stopping…" : "Stop"}
    </button>
  );
}

/**
 * Clear or Remove, never both: clearing keeps the branch, removing does not, and a worktree that
 * can be removed frees its build output with it — offering Clear beside Remove only invites the
 * wrong click. Remove asks the ledger first and only offers force after it has refused with a
 * reason.
 */
export function WorktreeActions({
  worktree,
  onDone,
}: {
  worktree: WorktreeHealth;
  onDone: () => void;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const buildKb = worktree.buildKb ?? 0;
  const canClear =
    !worktree.reclaimable &&
    !worktree.main &&
    !worktree.heldByClaim &&
    worktree.liveSessions === 0 &&
    buildKb > 0;

  const clear = async () => {
    setLabel("clearing…");
    const r = await reclaimBuildOutput(worktree.path);
    setLabel(r.ok ? `freed ${megabytes(r.freedKb ?? 0)}` : (r.error ?? "failed"));
    setTimeout(() => {
      setLabel(null);
      onDone();
    }, 1600);
  };

  const remove = async () => {
    if (!confirm(`Remove worktree ${worktree.path}?`)) return;
    setRemoving(true);
    let r = await removeWorktree(worktree.projectId, worktree.path);
    if (!r.ok && (r.refused === "dirty" || r.refused === "unpushed")) {
      if (confirm(`${r.error}\n\nRemove anyway (discards the work)?`)) {
        r = await removeWorktree(worktree.projectId, worktree.path, true);
      }
    }
    if (!r.ok && r.error && r.refused !== "dirty" && r.refused !== "unpushed") alert(r.error);
    // On success the row leaves the grid, so this component unmounts before it would matter.
    setRemoving(false);
    onDone();
  };

  return (
    <>
      {canClear && (
        <button
          type="button"
          className="mini-act"
          title="Delete node_modules, target and dist here — a rebuild recreates them; the branch and any uncommitted work are untouched"
          disabled={label !== null}
          onClick={clear}
        >
          {label ?? `Clear ${megabytes(buildKb)}`}
        </button>
      )}
      {worktree.reclaimable && (
        <button
          type="button"
          className="mini-act bad"
          title="Remove this worktree and its directory — it is merged, clean and pushed"
          disabled={removing}
          onClick={remove}
        >
          {removing ? "removing…" : "Remove"}
        </button>
      )}
    </>
  );
}
