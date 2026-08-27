/**
 * Every `/v1` route the dashboard reads, in one place (M11.2).
 *
 * These are path builders, not fetchers: a view passes the result to `useResource`, which owns the
 * polling and the abort. Keeping them here means a route's shape is stated once — the vanilla app
 * spelled `/v1/outcomes?project=…` out at each call site, and the query-string encoding drifted
 * between them.
 *
 * Response types come from `@swarm/core`, so these signatures are checked against the code that
 * produces the responses rather than against what someone read off the network tab.
 *
 * Each builder returns a `Route<T>` — a string that carries what the endpoint answers with — so
 * `useResource(routes.trials(p))` *infers* its type instead of being told one. The Trials view was
 * annotated `TrialReport[]` against a route that returns `{ trials: … }`; it type-checked, and
 * every visit to the view threw `data.filter is not a function`. Inference is what stops that: a
 * wrong annotation is now a compile error rather than a runtime one.
 */

import type {
  ContextReport,
  GateHealthReport,
  HeatReport,
  HygieneReport,
  McpHealthReport,
  OutcomeReport,
  ProvenanceReport,
  RuleEffectReport,
  SecurityReport,
} from "@swarm/core";
import type { TrialReport } from "@swarm/core/abtrial";
import type { IncidentEvent } from "@swarm/core/dashboard";
import type { ProjectPR } from "@swarm/core/forge";
import { query } from "./client";

/** `/v1/ab` answers with the list wrapped, not bare — the shape the Trials view got wrong. */
export interface TrialsResponse {
  trials: TrialReport[];
}

/**
 * A path that remembers what the endpoint returns.
 *
 * The brand is optional, so a plain string is still assignable — views that build a path inline
 * (a session's events, a graph tab) keep working by naming the type explicitly.
 */
export type Route<T> = string & { readonly __response?: T };

/** Routes scoped to one project, or to the whole machine when no project is selected. */
const byProject = <T>(path: string, project: string | null): Route<T> =>
  `${path}${query({ project })}`;

/** Every `/v1` path the dashboard reads, built once so encoding cannot drift between call sites. */
export const routes = {
  outcomes: (project: string | null) => byProject<OutcomeReport>("/v1/outcomes", project),
  hygiene: (project: string | null) => byProject<HygieneReport>("/v1/hygiene", project),
  gateHealth: (project: string | null) => byProject<GateHealthReport>("/v1/gates/health", project),
  mcpHealth: (project: string | null) => byProject<McpHealthReport>("/v1/mcp/health", project),
  context: (project: string | null) => byProject<ContextReport>("/v1/context", project),
  heat: (project: string | null) => byProject<HeatReport>("/v1/heat", project),
  security: (project: string | null) => byProject<SecurityReport>("/v1/security", project),
  provenance: (project: string | null) => byProject<ProvenanceReport>("/v1/provenance", project),
  ruleEffect: (project: string | null) => byProject<RuleEffectReport>("/v1/rules/effect", project),
  prs: (): Route<ProjectPR[]> => "/v1/prs",
  /** The full feed, not the snapshot's most-recent-20 window. */
  incidents: (project: string | null, openOnly: boolean): Route<IncidentEvent[]> =>
    `/v1/incidents${query({ project, limit: 500, open: openOnly ? 1 : null })}`,
  trials: (project: string | null) => byProject<TrialsResponse>("/v1/ab", project),
  /**
   * Unbranded on purpose: the daemon composes this report route-side and its shape is declared by
   * the Stats view (`views/stats/types.ts`), so branding it here would make `api/` import out of
   * `views/`. The caller names the type.
   */
  stats: (project: string | null): string => byProject("/v1/stats", project),
} as const;
