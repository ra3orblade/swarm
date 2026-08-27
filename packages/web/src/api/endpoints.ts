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
import { query } from "./client";

/** Routes scoped to one project, or to the whole machine when no project is selected. */
const byProject = (path: string, project: string | null) => `${path}${query({ project })}`;

/** Every `/v1` path the dashboard reads, built once so encoding cannot drift between call sites. */
export const routes = {
  outcomes: (project: string | null) => byProject("/v1/outcomes", project),
  hygiene: (project: string | null) => byProject("/v1/hygiene", project),
  gateHealth: (project: string | null) => byProject("/v1/gates/health", project),
  mcpHealth: (project: string | null) => byProject("/v1/mcp/health", project),
  context: (project: string | null) => byProject("/v1/context", project),
  heat: (project: string | null) => byProject("/v1/heat", project),
  security: (project: string | null) => byProject("/v1/security", project),
  provenance: (project: string | null) => byProject("/v1/provenance", project),
  ruleEffect: (project: string | null) => byProject("/v1/rules/effect", project),
  prs: () => "/v1/prs",
  /** The full feed, not the snapshot's most-recent-20 window. */
  incidents: (project: string | null, openOnly: boolean) =>
    `/v1/incidents${query({ project, limit: 500, open: openOnly ? 1 : null })}`,
  trials: (project: string | null) => byProject("/v1/ab", project),
  stats: (project: string | null) => byProject("/v1/stats", project),
  waiting: (project: string | null) => byProject("/v1/waiting", project),
} as const;

/**
 * The response type for each route above. A view writes
 * `useResource<ResponseOf["outcomes"]>(routes.outcomes(project))` and gets the domain type the
 * daemon actually returns.
 */
export interface ResponseOf {
  incidents: IncidentEvent[];
  trials: TrialReport[];
  outcomes: OutcomeReport;
  hygiene: HygieneReport;
  gateHealth: GateHealthReport;
  mcpHealth: McpHealthReport;
  context: ContextReport;
  heat: HeatReport;
  security: SecurityReport;
  provenance: ProvenanceReport;
  ruleEffect: RuleEffectReport;
}
