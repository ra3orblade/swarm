/**
 * Everything the dashboard can ask the daemon to *do* (M11.8).
 *
 * Separate from the read layer because writes are not symmetrical with reads: each one is
 * destructive or expensive, several need a confirmation, and every one of them ends by re-polling
 * so the UI shows what the daemon did rather than what it hoped.
 *
 * Nothing here guesses at the outcome. There is no optimistic update anywhere in this app: the
 * ledger is the truth, and a claim the daemon refused must not flicker as held.
 */

import { refreshSnapshot } from "../state/snapshot";
import { query, send } from "./client";

/** The daemon's standard write response. */
export interface WriteResult {
  ok: boolean;
  error?: string;
  /** Set when the ledger refused: `dirty`, `unpushed`, … */
  refused?: string;
}

/** Stop a registered process by pid. The registry verifies start time, so no pattern matching. */
export async function stopProcess(pid: number, projectId: string): Promise<WriteResult> {
  const result = await send<WriteResult>(
    `/v1/processes/${pid}${query({ project: projectId })}`,
    "DELETE",
  );
  await refreshSnapshot();
  return result;
}

/**
 * Remove a worktree. `force` discards uncommitted or unpushed work, so it is only ever sent after
 * the ledger has refused once and a human has said yes to that specific reason.
 */
export async function removeWorktree(
  projectId: string,
  worktree: string,
  force = false,
): Promise<WriteResult> {
  const result = await send<WriteResult>("/v1/worktrees/remove", "POST", {
    projectId,
    worktree,
    force,
  });
  await refreshSnapshot();
  return result;
}

export interface ReclaimResult extends WriteResult {
  freedKb?: number;
}

/**
 * Delete build output (`node_modules`, `target`, `dist`) inside one worktree.
 *
 * A different act from removing the worktree: the checkout, the branch and every uncommitted edit
 * survive, which is why a dirty tree is fine here and refused there.
 */
export async function reclaimBuildOutput(path: string): Promise<ReclaimResult> {
  const result = await send<ReclaimResult>("/v1/hygiene/reclaim", "POST", { path });
  await refreshSnapshot();
  return result;
}

/** Acknowledge one incident. */
export async function ackIncident(seq: number): Promise<void> {
  await send(`/v1/incidents/${seq}/ack`, "POST");
  await refreshSnapshot();
}

/** Acknowledge every open incident in scope. */
export async function ackAllIncidents(project: string | null): Promise<void> {
  await send(`/v1/incidents/ack${query({ project })}`, "POST");
  await refreshSnapshot();
}

/** Release a claim. `force` takes it from whoever holds it; the worktree is untouched either way. */
export async function releaseClaim(
  projectId: string,
  task: string,
  force = false,
): Promise<WriteResult> {
  const result = await send<WriteResult>("/v1/claims/release", "POST", { projectId, task, force });
  await refreshSnapshot();
  return result;
}

/** Release a runtime resource, forcibly — the holder is gone or wedged. */
export async function releaseResource(name: string, projectId: string | null): Promise<void> {
  await send(
    `/v1/resources/${encodeURIComponent(name)}${query({ force: 1, project: projectId })}`,
    "DELETE",
  );
  await refreshSnapshot();
}
