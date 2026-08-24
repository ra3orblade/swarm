/**
 * TeamForwarder (M8.3b): pushes the outbox + spend rollups to a team daemon's `/t1/ingest`.
 * Batched, at-least-once (the team side is idempotent by (machine, seq)), exponential backoff,
 * and never on the hook path — `store.append` only ever does a local INSERT.
 * See docs/14-teams.md; the receiving end is `packages/team`.
 */
import {
  clusterProjectKey,
  type TeamClaimSync,
  type TeamClaimsReply,
  type TeamIngestReply,
  type TeamIngestRequest,
  type TeamRecord,
} from "@swarm/core";
import { originUrl } from "./git";
import type { Store } from "./store";

const SPEND_EVERY_MS = 60_000;
const MAX_BACKOFF_MS = 300_000;

export class TeamForwarder {
  private lastTry = 0;
  private backoffMs = 0;
  private lastSpend = 0;
  private keyCache = new Map<string, string>();

  constructor(
    private store: Store,
    private version: string,
  ) {}

  /** Cluster project key (OQ-19): normalized origin remote, else `local:<project id>`. */
  private projectKey(projectId: string): string {
    const hit = this.keyCache.get(projectId);
    if (hit) return hit;
    const root = (
      this.store.db.query("SELECT root FROM projects WHERE id = ?").get(projectId) as {
        root: string | null;
      } | null
    )?.root;
    const key = (root && clusterProjectKey(originUrl(root))) || `local:${projectId}`;
    this.keyCache.set(projectId, key);
    return key;
  }

  status() {
    const team = this.store.policyFor(null).config.team;
    const box = this.store.outboxStatus();
    return {
      configured: team.url != null,
      url: team.url,
      forward: team.forward,
      pending: box.pending,
      oldest: box.oldest,
      lastAckAt: this.store.metaValue("team_last_ack") ?? null,
      lastError: this.store.metaValue("team_last_error") ?? null,
      machine: this.store.machineIdentity(),
      authed: this.store.metaValue("team_machine_token") != null,
    };
  }

  /** Called from the daemon tick; respects [team].interval and backoff internally. */
  async tick(now = Date.now()): Promise<number> {
    const team = this.store.policyFor(null).config.team;
    if (!team.url) return 0;
    if (now - this.lastTry < team.interval * 1000 + this.backoffMs) return 0;
    this.lastTry = now;

    const records: TeamRecord[] = [];
    const events = team.forward.includes("ledger") ? this.store.outboxPending() : [];
    for (const e of events) {
      const body = JSON.parse(e.payload) as Record<string, unknown>;
      if (typeof body.projectId === "string") body.projectKey = this.projectKey(body.projectId);
      records.push({ seq: e.seq, kind: e.kind as TeamRecord["kind"], body });
    }
    let spendRows = 0;
    if (team.forward.includes("cost") && now - this.lastSpend > SPEND_EVERY_MS) {
      const day = new Date(now).toISOString().slice(0, 10);
      for (const r of this.store.spendRollup(day)) {
        // spend rides outside the outbox: rows upsert by primary key on the team side, so a
        // re-send is harmless and there is nothing to ack. seq 0 never advances the high-water.
        records.push({
          seq: 0,
          kind: "spend",
          body: { day, ...r, projectKey: this.projectKey(r.projectId) },
        });
        spendRows++;
      }
    }
    // M8.3d: every held claim re-registers each flush — same-machine registration is the renewal,
    // and a 409-style conflict from the cluster revokes the local claim (worktree untouched).
    const held = this.store.heldClaimsForSync();
    if (!records.length && !held.length) return 0;

    const machine = { ...this.store.machineIdentity(), version: this.version };
    // machine token from `swarm login` (M8.3c); absent on open/lab deployments
    const token = this.store.metaValue("team_machine_token");
    const headers = {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const base = this.store.policyFor(null).config.team.url;
    try {
      if (records.length) {
        const req: TeamIngestRequest = { machine, records };
        const res = await fetch(`${base}/t1/ingest`, {
          method: "POST",
          headers,
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`ingest ${res.status}`);
        const reply = (await res.json()) as TeamIngestReply;
        if (reply.ack > 0) this.store.outboxAck(reply.ack);
        if (spendRows) this.lastSpend = now;
      }
      if (held.length) {
        const claims: TeamClaimSync[] = held.map((c) => ({
          projectKey: this.projectKey(c.projectId),
          task: c.task,
          acquiredAt: c.acquiredAt,
          expiresAt: c.expiresAt,
          actor: c.actorKind && c.actorId ? { kind: c.actorKind, id: c.actorId } : undefined,
        }));
        const res = await fetch(`${base}/t1/claims`, {
          method: "POST",
          headers,
          body: JSON.stringify({ machine, claims }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`claims ${res.status}`);
        const reply = (await res.json()) as TeamClaimsReply;
        for (const r of reply.results) {
          const local = held.find(
            (c) => c.task === r.task && this.projectKey(c.projectId) === r.projectKey,
          );
          if (!local) continue;
          if (r.status === "ok") {
            if (local.teamState !== "registered")
              this.store.markClaimTeamState(local.projectId, local.task, "registered");
          } else this.store.revokeClaimConflict(local.projectId, local.task, r.holder);
        }
      }
      this.backoffMs = 0;
      this.store.setMetaValue("team_last_ack", new Date(now).toISOString());
      this.store.setMetaValue("team_last_error", "");
      return records.length + held.length;
    } catch (e) {
      // offline or unreachable: keep everything, back off, report via /v1/team + doctor.
      // Cluster claims degrade to advisory — local fail-closed semantics keep working.
      this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : 5000, MAX_BACKOFF_MS);
      this.store.setMetaValue("team_last_error", (e as Error).message);
      return 0;
    }
  }
}
