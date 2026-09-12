#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { DEFAULT_TEAM_SETUP, mintTeamSecret, renderTeamSetup, type TeamSetup } from "@swarm/core";
import { createTeamApp, VERSION } from "./app";
import { readTeamSetup, teamConfigPath, teamEnv } from "./config";
import { TeamStore } from "./store";

// `swarm-teamd setup`: write ~/.swarm/team.toml so hosting needs no exported secrets. Flags for
// scripts; prompts for a person. Nothing else in the file is touched — it is rewritten whole.
if (process.argv[2] === "setup") {
  const args = process.argv.slice(3);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const interactive = !args.length && process.stdin.isTTY;
  const ask = async (q: string, fallback: string): Promise<string> => {
    if (!interactive) return fallback;
    process.stdout.write(`${q} [${fallback}]: `);
    for await (const line of console) return line.trim() || fallback;
    return fallback;
  };
  const cur = readTeamSetup();
  const mode = (flag("mode") ?? (await ask("auth mode (token | oidc | open)", cur.mode))) as
    | "token"
    | "oidc"
    | "open";
  const setup: TeamSetup = {
    ...DEFAULT_TEAM_SETUP,
    ...cur,
    name: flag("name") ?? (await ask("team name", cur.name ?? "")) ?? null,
    host: flag("host") ?? cur.host,
    port: Number(flag("port") ?? (await ask("port", String(cur.port)))) || cur.port,
    mode: mode === "oidc" || mode === "open" ? mode : "token",
  };
  if (!setup.name) setup.name = null;
  if (setup.mode === "token") setup.token = flag("token") ?? cur.token ?? mintTeamSecret();
  if (setup.mode === "oidc") {
    setup.issuer = flag("issuer") ?? (await ask("OIDC issuer", cur.issuer ?? "")) ?? null;
    setup.clientId = flag("client-id") ?? (await ask("OIDC client id", cur.clientId ?? "")) ?? null;
  }
  const path = teamConfigPath();
  writeFileSync(path, renderTeamSetup(setup), { mode: 0o600 });
  console.log(`wrote ${path}`);
  console.log(`start it with: swarm-teamd`);
  if (setup.mode === "token" && setup.token)
    console.log(
      `teammates run:  swarm login http://<this-host>:${setup.port} --token ${setup.token}`,
    );
  if (setup.mode === "open") console.log("mode = open: no auth. Never run this beyond a lab.");
  process.exit(0);
}

// The file's settings become process.env where the environment did not already speak, so the
// store (SWARM_TEAM_DB) and auth (authEnv) need no new code path.
for (const [k, v] of Object.entries(teamEnv())) if (v !== undefined) process.env[k] ??= v;
const env = process.env;

// Unlike the local swarmd (loopback-only), the team daemon serves a network: bind 0.0.0.0 by
// default, SWARM_TEAM_HOST/SWARM_TEAM_PORT to override. Every non-health route is bearer-authed
// from M8.3c on; put TLS in front (reverse proxy) for anything beyond a lab.
const PORT = Number(env.SWARM_TEAM_PORT ?? 7878);
const HOST = env.SWARM_TEAM_HOST ?? "0.0.0.0";

const store = new TeamStore();
const app = createTeamApp(store);
const server = Bun.serve({ port: PORT, hostname: HOST, idleTimeout: 0, fetch: app.fetch });
console.error(
  `swarm-teamd ${VERSION} listening on ${HOST}:${server.port} (schema v${store.schemaVersion()})`,
);

const stop = () => {
  server.stop();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
