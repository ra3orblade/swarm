/**
 * The team daemon's settings (M13.12): `~/.swarm/team.toml`, with the environment on top.
 *
 * Env wins so every deployment that predates the file keeps behaving exactly as it did; the file
 * exists so a person can host a team without exporting secrets in a shell — `swarm-teamd setup`
 * and the dashboard's Team panel both write it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTeamSetup, type TeamSetup, teamSetupEnv } from "@swarm/core";

export function teamConfigPath(): string {
  return (
    process.env.SWARM_TEAM_CONFIG ??
    join(process.env.SWARM_HOME ?? join(homedir(), ".swarm"), "team.toml")
  );
}

export function readTeamSetup(path = teamConfigPath()): TeamSetup {
  return parseTeamSetup(existsSync(path) ? readFileSync(path, "utf8") : null);
}

/** `process.env` with the file's settings filled in underneath it. */
export function teamEnv(
  env: Record<string, string | undefined> = process.env,
  setup: TeamSetup = readTeamSetup(),
): Record<string, string | undefined> {
  const fromFile = teamSetupEnv(setup);
  const out: Record<string, string | undefined> = { ...fromFile };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
