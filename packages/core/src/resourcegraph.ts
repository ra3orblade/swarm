/**
 * Resource-holding graph (M9.17): who holds what, and who wanted what somebody else had.
 *
 * Three kinds of resource are already in the ledger — task claims, runtime resources (ports and
 * named leases) and tracked processes — and each one names an owner. Drawing them together
 * answers two questions a table cannot: what is a single session sitting on, and where do two
 * agents want the same things.
 *
 * **On wait cycles.** The roadmap asked for deadlock detection, and a strict deadlock cannot
 * happen here by construction: claims fail closed, so a second claimer is *refused* rather than
 * queued, and nobody ever blocks holding one resource while waiting on another. What can happen
 * is contention: A holds T1 and was refused T2, while B holds T2 and was refused T1. Neither is
 * stuck, but they are working against each other, and that is worth a human's attention. Those
 * cycles are what {@link findContention} finds, and the wanted-edges come from `claim.denied`,
 * which the daemon now records at the point of refusal — before this, a refusal left no trace at
 * all and the relation was simply not in the data.
 *
 * Pure and deterministic: rows in, graph out, every tie broken by name.
 */

export type HeldKind = "claim" | "port" | "lease" | "process";

/** One held thing. `endedAt` is the *holder's* session end, which is what makes it orphaned. */
export interface HeldRow {
  kind: HeldKind;
  /** Display name: the task, the port, the lease name, the process name. */
  name: string;
  owner: string;
  sessionId: string | null;
  /** Set when the holding session has ended — the resource outlived whoever took it. */
  sessionEndedAt?: string | null;
  /** Lease expiry, when the resource has one. */
  expiresAt?: string | null;
  projectId?: string | null;
}

/** Somebody asked for a resource that was already held. From `claim.denied`. */
export interface WantedRow {
  kind: HeldKind;
  name: string;
  /** Who was refused. */
  owner: string;
  /** Who had it at the time. */
  heldBy: string;
  at: string;
  /** Must match the held row's project, or the two never join. */
  projectId?: string | null;
}

export interface ResourceNode {
  id: string;
  kind: HeldKind;
  name: string;
  holder: string | null;
  /** Its holder's session has ended, or its lease has expired: nobody is coming back for it. */
  orphaned: boolean;
  /** Owners refused this resource while it was held. */
  wanted: string[];
  projectId: string | null;
}

export interface HolderNode {
  id: string;
  /** Resources this owner holds, by kind. */
  holds: number;
  /** Resources this owner asked for and did not get. */
  wants: number;
  /** Every resource it holds is orphaned — the owner itself is gone. */
  gone: boolean;
}

export interface ResourceEdge {
  from: string;
  to: string;
  kind: "holds" | "wants";
}

/** A ring of owners each wanting something the next one holds. */
export interface Contention {
  owners: string[];
  /** The resources that close the ring, in the same order as `owners`. */
  resources: string[];
}

export interface ResourceGraph {
  holders: HolderNode[];
  resources: ResourceNode[];
  edges: ResourceEdge[];
  contention: Contention[];
  totals: { held: number; orphaned: number; contested: number };
}

const nodeId = (kind: HeldKind, name: string, projectId?: string | null) =>
  `${kind}:${projectId ?? ""}:${name}`;

/**
 * Assemble the graph. `now` is injected so the orphan verdict is testable rather than dependent
 * on the wall clock.
 */
export function resourceGraph(
  held: readonly HeldRow[],
  wanted: readonly WantedRow[] = [],
  now: number = Date.now(),
): ResourceGraph {
  const resources = new Map<string, ResourceNode>();
  const holders = new Map<string, { holds: number; wants: number; live: number }>();

  for (const h of held) {
    if (!h.name || !h.owner) continue;
    const id = nodeId(h.kind, h.name, h.projectId);
    const expired = h.expiresAt ? Date.parse(h.expiresAt) < now : false;
    const orphaned = Boolean(h.sessionEndedAt) || expired;
    // Two rows for one resource should not double-count; the first holder wins, deterministically.
    if (!resources.has(id))
      resources.set(id, {
        id,
        kind: h.kind,
        name: h.name,
        holder: h.owner,
        orphaned,
        wanted: [],
        projectId: h.projectId ?? null,
      });
    const o = holders.get(h.owner) ?? { holds: 0, wants: 0, live: 0 };
    o.holds++;
    if (!orphaned) o.live++;
    holders.set(h.owner, o);
  }

  for (const w of wanted) {
    if (!w.name || !w.owner) continue;
    const r = resources.get(nodeId(w.kind, w.name, w.projectId));
    // A refusal for something nobody holds any more is history, not contention.
    if (!r || r.holder === w.owner) continue;
    if (!r.wanted.includes(w.owner)) r.wanted.push(w.owner);
    const o = holders.get(w.owner) ?? { holds: 0, wants: 0, live: 0 };
    o.wants++;
    holders.set(w.owner, o);
  }
  for (const r of resources.values()) r.wanted.sort();

  const edges: ResourceEdge[] = [];
  for (const r of [...resources.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (r.holder) edges.push({ from: r.holder, to: r.id, kind: "holds" });
    for (const w of r.wanted) edges.push({ from: w, to: r.id, kind: "wants" });
  }

  const resourceList = [...resources.values()].sort(
    (a, b) =>
      Number(b.wanted.length > 0) - Number(a.wanted.length > 0) ||
      Number(b.orphaned) - Number(a.orphaned) ||
      a.id.localeCompare(b.id),
  );
  const holderList: HolderNode[] = [...holders.entries()]
    .map(([id, o]) => ({ id, holds: o.holds, wants: o.wants, gone: o.holds > 0 && o.live === 0 }))
    .sort((a, b) => b.holds + b.wants - (a.holds + a.wants) || a.id.localeCompare(b.id));

  return {
    holders: holderList,
    resources: resourceList,
    edges,
    contention: findContention(resourceList),
    totals: {
      held: resourceList.length,
      orphaned: resourceList.filter((r) => r.orphaned).length,
      contested: resourceList.filter((r) => r.wanted.length > 0).length,
    },
  };
}

/**
 * Rings of owners each wanting something the next holds. Depth-first over `owner → holder of a
 * resource this owner was refused`, reporting each ring once by its rotation with the smallest
 * first owner, so the same ring is never listed twice under different starting points.
 */
export function findContention(resources: readonly ResourceNode[]): Contention[] {
  // owner -> [{ next holder, via resource }]
  const next = new Map<string, Array<{ to: string; via: string }>>();
  for (const r of resources) {
    if (!r.holder) continue;
    for (const w of r.wanted) {
      const list = next.get(w) ?? [];
      list.push({ to: r.holder, via: r.name });
      next.set(w, list);
    }
  }
  for (const list of next.values())
    list.sort((a, b) => a.to.localeCompare(b.to) || a.via.localeCompare(b.via));

  const found = new Map<string, Contention>();
  const walk = (start: string, at: string, owners: string[], vias: string[], depth: number) => {
    if (depth > 6) return; // rings longer than this are not something a person acts on
    for (const step of next.get(at) ?? []) {
      if (step.to === start) {
        const ring = [...owners];
        const res = [...vias, step.via];
        // Canonical rotation: start the ring at its alphabetically smallest owner.
        const pivot = ring.indexOf([...ring].sort()[0] as string);
        const key = [...ring.slice(pivot), ...ring.slice(0, pivot)].join(">");
        if (!found.has(key))
          found.set(key, {
            owners: [...ring.slice(pivot), ...ring.slice(0, pivot)],
            resources: [...res.slice(pivot), ...res.slice(0, pivot)],
          });
        continue;
      }
      if (owners.includes(step.to)) continue;
      walk(start, step.to, [...owners, step.to], [...vias, step.via], depth + 1);
    }
  };
  for (const owner of [...next.keys()].sort()) walk(owner, owner, [owner], [], 0);
  return [...found.values()].sort(
    (a, b) => a.owners.length - b.owners.length || a.owners.join().localeCompare(b.owners.join()),
  );
}
