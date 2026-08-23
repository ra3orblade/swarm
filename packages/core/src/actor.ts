/**
 * Who did it (M8.2a). Every ledger record and event carries an Actor. Until the daemon
 * authenticates callers (M8.2b) the actor is derived from what clients already send — the
 * free-form `owner` / `by` strings and the session id — so the mapping below is also the
 * back-fill rule for rows written before this existed.
 */
export type ActorKind = "human" | "agent" | "run" | "daemon";

export interface Actor {
  kind: ActorKind;
  /** OS user / OIDC subject for humans; session id for agents; run id for spawned runs; "daemon". */
  id: string;
  /** The Claude Code session acting, when known (agents and runs). */
  session?: string | undefined;
}

/** Owner strings that have always meant "the person at the keyboard". */
const HUMAN_ALIASES = new Set(["cli", "dashboard", "me", "desktop", "human"]);
const DAEMON_ALIASES = new Set(["daemon", "system", "swarm"]);

/** Best actor for a free-form `owner` / `by` + optional session id; never throws. */
export function actorFrom(
  owner: string | null | undefined,
  sessionId?: string | null,
  opts: { user?: string | null | undefined; runId?: string | null | undefined } = {},
): Actor {
  const o = (owner ?? "").trim();
  const sid = sessionId?.trim() || undefined;
  if (opts.runId) return { kind: "run", id: opts.runId, session: sid };
  if (o.startsWith("auto:")) return { kind: "daemon", id: "daemon", session: sid };
  if (DAEMON_ALIASES.has(o)) return { kind: "daemon", id: "daemon" };
  if (o === "agent" || o.startsWith("agent:") || o.startsWith("session:"))
    return {
      kind: "agent",
      id: sid ?? o.replace(/^(agent|session):/, "") ?? "agent",
      session: sid,
    };
  if (!o || HUMAN_ALIASES.has(o)) {
    if (!o && sid) return { kind: "agent", id: sid, session: sid };
    return { kind: "human", id: opts.user?.trim() || "me" };
  }
  // A named owner is a person (process.env.USER, a teammate) unless it is plainly a session id.
  if (sid && o === sid) return { kind: "agent", id: sid, session: sid };
  return { kind: "human", id: o };
}

/** Short display form: `alice`, `agent 9a53cfd3`, `run r_x1`, `daemon`. */
export function actorLabel(a: Actor | null | undefined): string {
  if (!a) return "—";
  if (a.kind === "human") return a.id;
  if (a.kind === "agent") return `agent ${a.id.slice(0, 8)}`;
  if (a.kind === "run") return `run ${a.id}`;
  return "daemon";
}

/** Parse the two ledger columns back into an Actor; null when the row predates M8.2a and has none. */
export function actorFromColumns(
  kind: string | null | undefined,
  id: string | null | undefined,
  session?: string | null,
): Actor | null {
  if (!kind || !id) return null;
  if (!["human", "agent", "run", "daemon"].includes(kind)) return null;
  const a: Actor = { kind: kind as ActorKind, id };
  if (session && kind !== "human" && kind !== "daemon") a.session = session;
  return a;
}
