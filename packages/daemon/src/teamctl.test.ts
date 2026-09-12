import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Store } from "./store";
import { hostingStatus, hostTeam, joinTeam, leaveTeam, readSetup } from "./teamctl";

const home = () => mkdtempSync(join(tmpdir(), "swarm-team-"));

/** A stand-in team daemon: the two routes joining touches. `packages/team` is never imported. */
function stubTeam(opts: { mode: "token" | "oidc" | "open"; secret?: string }) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/t1/health") return Response.json({ ok: true });
      if (url.pathname === "/t1/auth/config")
        return Response.json({ mode: opts.mode, policyPublicKey: "pub_key_abc" });
      if (url.pathname === "/t1/machines/register") {
        const bearer = req.headers.get("authorization")?.replace("Bearer ", "") ?? null;
        if (opts.mode === "token" && bearer !== opts.secret)
          return Response.json({ error: "bad secret" }, { status: 401 });
        return Response.json({ token: "machine_token_xyz" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("host or join a team from the app (M13.12)", () => {
  it("joins from an invite link, stores the credentials and points config at the team", async () => {
    const store = new Store(home());
    const team = stubTeam({ mode: "token", secret: "swt_secret" });
    try {
      const bad = await joinTeam(store, { invite: "not a url" });
      expect(bad).toEqual({ ok: false, error: "paste an invite link or the team daemon's URL" });

      const wrongSecret = await joinTeam(store, { invite: `${team.url}#swt_nope` });
      expect(wrongSecret.ok).toBe(false);
      expect(store.metaValue("team_machine_token")).toBeNull();

      const r = await joinTeam(store, { invite: `${team.url}#swt_secret` });
      expect(r).toEqual({ ok: true, url: team.url, mode: "token" });
      expect(store.metaValue("team_machine_token")).toBe("machine_token_xyz");
      // the policy key is pinned at the trusted moment, exactly as `swarm login` does it
      expect(store.metaValue("team_policy_pubkey")).toBe("pub_key_abc");
      expect(readFileSync(join(store.home, "config.toml"), "utf8")).toContain(
        `url = "${team.url}"`,
      );
      expect(store.policyFor(null).config.team.url).toBe(team.url);

      // leaving clears the pointer and the credential, and never touches the local ledger
      expect(await leaveTeam(store)).toEqual({ ok: true, stopped: false });
      expect(store.metaValue("team_machine_token")).toBeNull();
      expect(readFileSync(join(store.home, "config.toml"), "utf8")).not.toContain("url =");
    } finally {
      team.stop();
    }
  });

  it("says so when nothing answers, and when the team wants an identity provider", async () => {
    const store = new Store(home());
    const dead = await joinTeam(store, { invite: "http://127.0.0.1:1" });
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.error).toContain("no team daemon answering");

    const oidc = stubTeam({ mode: "oidc" });
    try {
      const r = await joinTeam(store, { invite: oidc.url });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("swarm login");
    } finally {
      oidc.stop();
    }
  });

  it("refuses to host on a busy port and on a half-configured OIDC team; status stays honest", async () => {
    const store = new Store(home());
    expect(hostingStatus(store)).toMatchObject({ hosting: false, pid: null, invite: null });

    // a port something else already holds
    const other = stubTeam({ mode: "open" });
    try {
      const port = Number(new URL(other.url).port);
      const busy = await hostTeam(store, { mode: "token", port });
      expect(busy.ok).toBe(false);
      if (!busy.ok) expect(busy.error).toContain("already listening");
      // the settings it would have used were still written, secret and all
      const setup = readSetup(store.home);
      expect(setup.port).toBe(port);
      expect(setup.token).toMatch(/^swt_/);
      expect(existsSync(join(store.home, "team.toml"))).toBe(true);
    } finally {
      other.stop();
    }

    const oidc = await hostTeam(store, { mode: "oidc", port: 7999 });
    expect(oidc.ok).toBe(false);
    if (!oidc.ok) expect(oidc.error).toContain("issuer");
  });

  it("serves hosting state and the actions over HTTP", async () => {
    const store = new Store(home());
    const { app } = createApp(store);
    const team = stubTeam({ mode: "open" });
    try {
      const status = (await (await app.request("/v1/team")).json()) as {
        configured: boolean;
        hosting: boolean;
      };
      expect(status).toMatchObject({ configured: false, hosting: false });

      const joined = await app.request("/v1/team/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: team.url }),
      });
      expect(joined.status).toBe(200);
      const after = (await (await app.request("/v1/team")).json()) as { configured: boolean };
      expect(after.configured).toBe(true);

      const left = await app.request("/v1/team/leave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(await left.json()).toEqual({ ok: true, stopped: false });

      const refused = await app.request("/v1/team/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: "" }),
      });
      expect(refused.status).toBe(409);
    } finally {
      team.stop();
    }
  });

  it("keeps an existing [team] section's other keys when the url changes", async () => {
    const store = new Store(home());
    writeFileSync(
      join(store.home, "config.toml"),
      '[team]\nurl = "http://old"\nforward = ["ledger"]\ninterval = 9\n',
    );
    const team = stubTeam({ mode: "open" });
    try {
      await joinTeam(store, { invite: team.url });
      const text = readFileSync(join(store.home, "config.toml"), "utf8");
      expect(text).toContain(`url = "${team.url}"`);
      expect(text).toContain('forward = ["ledger"]');
      expect(text).toContain("interval = 9");
    } finally {
      team.stop();
    }
  });
});
