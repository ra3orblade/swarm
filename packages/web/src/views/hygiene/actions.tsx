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
 * Clear and Remove, side by side but never confused: clearing keeps the branch, removing does not.
 * Remove asks the ledger first and only offers force after it has refused with a reason.
 */
export function WorktreeActions({
  worktree,
  onDone,
}: {
  worktree: WorktreeHealth;
  onDone: () => void;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const buildKb = worktree.buildKb ?? 0;
  const canClear =
    !worktree.main && !worktree.heldByClaim && worktree.liveSessions === 0 && buildKb > 0;

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
    const first = await removeWorktree(worktree.projectId, worktree.path);
    if (!first.ok && (first.refused === "dirty" || first.refused === "unpushed")) {
      if (confirm(`${first.error}\n\nRemove anyway (discards the work)?`)) {
        await removeWorktree(worktree.projectId, worktree.path, true);
      }
    } else if (!first.ok && first.error) {
      alert(first.error);
    }
    onDone();
  };

  return (
    <>
      {canClear && (
        <button
          type="button"
          className="mini-act"
          title="Delete node_modules, target and dist here — a rebuild recreates them; the branch and any uncommitted work are untouched"
          onClick={clear}
        >
          {label ?? `Clear ${megabytes(buildKb)}`}
        </button>
      )}
      {worktree.reclaimable && (
        <button
          type="button"
          className="mini-act bad"
          title="Remove this worktree"
          onClick={remove}
        >
          Remove
        </button>
      )}
    </>
  );
}
