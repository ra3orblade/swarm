/**
 * Runtime resources (Phase 1): named singletons for the things agents fight over at
 * runtime — ports, long-running processes, databases, fixtures.
 *
 * Semantics mirror claims but for live infrastructure:
 *  - `acquire` is fail-closed: a name can be held by exactly one owner.
 *  - A holding is *alive* while its pid is running (pid-tracked) or its lease hasn't
 *    expired (lease-tracked). Dead holdings are reaped, not blocking.
 *  - A held `port` resource is automatically a protected port for the rules engine.
 */

export type ResourceKind = "port" | "process" | "custom";

export interface Resource {
  /** Singleton name, e.g. "dev-server", "db-main", "port:3000". */
  name: string;
  kind: ResourceKind;
  /** Project scope; null = machine-global. */
  projectId: string | null;
  owner: string;
  sessionId: string | null;
  /** Tracked process; when it dies the holding is reapable. */
  pid: number | null;
  /** The port this resource occupies (kind "port", or a process that binds one). */
  port: number | null;
  acquiredAt: string;
  /** Lease expiry for holdings without a pid; null = pid-tracked or unbounded. */
  expiresAt: string | null;
  released: boolean;
}

export const DEFAULT_RESOURCE_LEASE_MINUTES = 60;

export type AcquireDecision = { ok: true } | { ok: false; reason: "held"; holder: Resource };

/** A holding blocks a new acquire only while it is still alive. */
export function isAliveHolding(
  r: Pick<Resource, "released" | "pid" | "expiresAt">,
  now: number,
  pidAlive: (pid: number) => boolean,
): boolean {
  if (r.released) return false;
  if (r.pid != null) return pidAlive(r.pid);
  if (r.expiresAt != null) return new Date(r.expiresAt).getTime() > now;
  return true; // unbounded holding: alive until released
}

export function canAcquire(
  existing: Resource | null,
  requester: { owner: string; sessionId?: string | null },
  now: number,
  pidAlive: (pid: number) => boolean,
): AcquireDecision {
  if (!existing || !isAliveHolding(existing, now, pidAlive)) return { ok: true };
  // Re-acquire by the same owner refreshes rather than blocks.
  if (existing.owner === requester.owner) return { ok: true };
  return { ok: false, reason: "held", holder: existing };
}

export function acquireRefusalMessage(holder: Resource): string {
  const via =
    holder.pid != null
      ? `pid ${holder.pid}`
      : holder.expiresAt
        ? `lease until ${holder.expiresAt}`
        : "unbounded";
  return (
    `Resource "${holder.name}" is held by ${holder.owner} (${via}).` +
    ` Pick another name, coordinate with the holder, or wait for release/reap.`
  );
}
