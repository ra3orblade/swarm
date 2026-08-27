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

import type { Project } from "@swarm/core/types";
import { refreshSnapshot } from "../state/snapshot";
import { ApiError, OfflineError, query, send } from "./client";

/** The daemon's standard write response. */
export interface WriteResult {
  ok: boolean;
  error?: string;
  /** Set when the ledger refused: `dirty`, `unpushed`, … */
  refused?: string;
}

/**
 * Read a write response that may or may not use the `{ ok }` envelope.
 *
 * The ledger's routes answer `{ ok: false, error }`; the older ones answer a bare `{ error }` with
 * a 4xx, and `/v1/projects` answers with the created object and no envelope at all. Success is
 * therefore "a body with no error in it" rather than any single flag — assuming otherwise reported
 * an invalid path as success.
 */
function asResult(body: unknown): WriteResult {
  if (typeof body !== "object" || body === null) return { ok: true };
  const record = body as { ok?: unknown; error?: unknown; refused?: unknown };
  const error = typeof record.error === "string" ? record.error : undefined;
  const ok = record.ok === undefined ? error === undefined : record.ok === true;
  return {
    ok,
    ...(error === undefined ? {} : { error }),
    ...(typeof record.refused === "string" ? { refused: record.refused } : {}),
  };
}

/** Stop a registered process by pid. The registry verifies start time, so no pattern matching. */
export async function stopProcess(pid: number, projectId: string): Promise<WriteResult> {
  const result = asResult(
    await send(`/v1/processes/${pid}${query({ project: projectId })}`, "DELETE"),
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
  const result = asResult(
    await send("/v1/worktrees/remove", "POST", { projectId, worktree, force }),
  );
  await refreshSnapshot();
  return result;
}

/** The reclaim response, which reports how much disk actually came back. */
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
  const result = asResult(await send("/v1/claims/release", "POST", { projectId, task, force }));
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

/**
 * Track a folder as a project.
 *
 * Unlike the ledger's writes this one answers with the created {@link Project} rather than an
 * `{ ok }` envelope, so success is the absence of an error rather than a flag. A path inside a
 * worktree resolves to the repository that owns it, which is why adding one can return a project
 * you already had.
 */
export async function addProject(path: string): Promise<WriteResult> {
  try {
    const result = asResult(await send<Project>("/v1/projects", "POST", { path }));
    if (result.ok) await refreshSnapshot();
    return result;
  } catch (cause) {
    if (cause instanceof ApiError || cause instanceof OfflineError) {
      return { ok: false, error: cause.message };
    }
    throw cause;
  }
}
