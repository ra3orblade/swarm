/**
 * Process registry (M1.4 Phase 2): pid-tracked processes started through `swarm serve` /
 * `swarm proc`, keyed by the project (working directory) that started them — never by command
 * pattern. Liveness is pid + start time, so a recycled pid is never mistaken for ours.
 */

export type ProcessKind = "serve" | "proc" | "gate";

export interface TrackedProcess {
  pid: number;
  /** `ps -o lstart=` at registration; a different value later means the pid was recycled. */
  startTime: string | null;
  projectId: string;
  sessionId: string | null;
  kind: ProcessKind;
  /** Singleton name; also the runtime resource it holds. */
  name: string;
  port: number | null;
  cwd: string;
  cmd: string;
  owner: string;
  /** Log file the CLI pointed stdout/stderr at. */
  log: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** First port ≥ `from` that is neither taken in the ledger nor refused by `isFree` (a bind probe). */
export function pickPort(
  from: number,
  taken: Iterable<number>,
  isFree: (port: number) => boolean,
  span = 200,
): number | null {
  const t = new Set(taken);
  for (let p = from; p < Math.min(from + span, 65536); p++) {
    if (t.has(p)) continue;
    if (isFree(p)) return p;
  }
  return null;
}

/** A registry row is ours to signal only if the pid is alive AND its start time still matches. */
export function isOurs(
  row: Pick<TrackedProcess, "pid" | "startTime">,
  alive: boolean,
  currentStartTime: string | null,
): boolean {
  if (!alive) return false;
  if (row.startTime == null || currentStartTime == null) return true; // no start-time support: trust the pid
  return row.startTime === currentStartTime;
}

/** Default starting port for `swarm serve` when none is given. */
export const DEFAULT_FROM_PORT = 3400;
