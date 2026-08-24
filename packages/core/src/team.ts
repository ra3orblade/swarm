/**
 * Team forwarding (M8.3b): the wire shapes the local daemon POSTs to a team daemon's
 * `/t1/ingest`, and the cluster project identity (OQ-19). The forwarding *seam* is free and lives
 * here in `core`; the receiving team daemon is `packages/team`. See docs/14-teams.md.
 */

/** One outbox record on the wire. `seq` is the machine-local outbox sequence — the team side is
 *  idempotent by (machine id, seq), so at-least-once delivery is safe. */
export interface TeamRecord {
  seq: number;
  kind: "event" | "spend";
  body: Record<string, unknown>;
}

export interface TeamIngestRequest {
  machine: { id: string; name: string; version: string };
  records: TeamRecord[];
}

export interface TeamIngestReply {
  /** Highest `seq` the team daemon has durably stored for this machine. */
  ack: number;
}

/** Cluster claim registration (M8.3d): local-first, then registered upstream; a conflict revokes
 *  the local claim. Registering again from the same machine is the renewal. */
export interface TeamClaimSync {
  projectKey: string;
  task: string;
  acquiredAt: string;
  expiresAt: string;
  actor?: { kind: string; id: string } | undefined;
}

export interface TeamClaimsRequest {
  machine: { id: string; name: string; version: string };
  claims: TeamClaimSync[];
}

export type TeamClaimResult =
  | { projectKey: string; task: string; status: "ok" }
  | { projectKey: string; task: string; status: "conflict"; holder: string };

export interface TeamClaimsReply {
  results: TeamClaimResult[];
}

/**
 * Cluster project identity (OQ-19): the normalized `origin` remote URL — protocol, credentials
 * and `.git` stripped, host lowercased — so the same repo cloned on two machines shares one key.
 * Returns null for unparseable/absent remotes; the caller falls back to `local:<project id>`,
 * which keeps unpushed repos machine-local by construction.
 */
export function clusterProjectKey(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const url = remoteUrl.trim();
  // http(s) first — the scp-style pattern would otherwise swallow "https" as a host
  const m =
    url.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/) ??
    url.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (!m?.[1] || !m[2]) return null;
  const host = m[1].toLowerCase();
  if (host.includes(" ") || !host.includes(".")) return null;
  return `${host}/${m[2]}`;
}
