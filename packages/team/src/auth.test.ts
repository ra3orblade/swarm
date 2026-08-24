import { afterEach, describe, expect, it } from "bun:test";
import { createTeamApp } from "./app";
import { authMode, principalFor } from "./auth";
import { TeamStore } from "./store";

const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A minimal OIDC issuer: discovery, device grant (pending once, then an RS256 id_token), JWKS. */
async function mockIssuer(clientId: string, sub = "user-1") {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as {
    kty: string;
    n: string;
    e: string;
  };
  let url = "";
  let polls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/.well-known/openid-configuration")
        return Response.json({
          issuer: url,
          device_authorization_endpoint: `${url}/device`,
          token_endpoint: `${url}/token`,
          jwks_uri: `${url}/jwks`,
        });
      if (path === "/device")
        return Response.json({
          device_code: "dc-1",
          user_code: "WDJB-MJHT",
          verification_uri: `${url}/activate`,
          interval: 1,
          expires_in: 600,
        });
      if (path === "/token") {
        polls++;
        if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
        const header = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
        const payload = enc({
          iss: url,
          aud: clientId,
          exp: Math.floor(Date.now() / 1000) + 600,
          sub,
          email: "alice@example.com",
          name: "Alice",
        });
        const sig = Buffer.from(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            keys.privateKey,
            new TextEncoder().encode(`${header}.${payload}`),
          ),
        ).toString("base64url");
        return Response.json({ id_token: `${header}.${payload}.${sig}` });
      }
      if (path === "/jwks") return Response.json({ keys: [{ ...jwk, kid: "k1", kty: "RSA" }] });
      return new Response("not found", { status: 404 });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
  return { url, server };
}

let stop: (() => void) | null = null;
afterEach(() => stop?.());

describe("team auth (M8.3c)", () => {
  it("device-code login end-to-end: pending → id_token verified → opaque token, first user admin", async () => {
    const issuer = await mockIssuer("swarm-team");
    stop = () => issuer.server.stop(true);
    const store = new TeamStore(":memory:");
    const env = { issuer: issuer.url, clientId: "swarm-team" };
    const app = createTeamApp(store, env);

    const flow = (await (await app.request("/t1/auth/device", { method: "POST" })).json()) as {
      handle: string;
      userCode: string;
    };
    expect(flow.userCode).toBe("WDJB-MJHT");

    const poll = (h: string) =>
      app.request("/t1/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: h }),
      });
    expect(await (await poll(flow.handle)).json()).toEqual({ status: "pending" });
    const ok = (await (await poll(flow.handle)).json()) as {
      status: string;
      token: string;
      subject: string;
      role: string;
    };
    expect(ok.status).toBe("ok");
    expect(ok.subject).toBe("user-1");
    expect(ok.role).toBe("admin"); // first user

    const me = await app.request("/t1/me", {
      headers: { authorization: `Bearer ${ok.token}` },
    });
    expect(await me.json()).toEqual({ kind: "human", subject: "user-1", role: "admin" });
    // an unknown token is rejected
    expect(
      (await app.request("/t1/me", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    // second user is a viewer
    expect(store.upsertUser({ sub: "user-2" }).role).toBe("viewer");
  });

  it("machine registration binds to the user; ingest takes machine auth only", async () => {
    const issuer = await mockIssuer("cid");
    stop = () => issuer.server.stop(true);
    const store = new TeamStore(":memory:");
    const env = { issuer: issuer.url, clientId: "cid" };
    const app = createTeamApp(store, env);
    const human = store.upsertUser({ sub: "dev-1" }); // first → admin
    expect(human.role).toBe("admin");
    const { mintToken } = await import("./auth");
    const t = mintToken();
    store.storeToken(t.hash, "dev-1");

    const reg = await app.request("/t1/machines/register", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ id: "m-1", name: "laptop" }),
    });
    const { token: machineToken } = (await reg.json()) as { token: string };
    expect(machineToken).toStartWith("swt_");

    const ingest = (auth: string | null, machineId = "m-1") =>
      app.request("/t1/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify({ machine: { id: machineId }, records: [] }),
      });
    expect((await ingest(null)).status).toBe(401);
    expect((await ingest(t.token)).status).toBe(403); // humans don't ingest
    expect((await ingest(machineToken)).status).toBe(200);
    expect((await ingest(machineToken, "m-2")).status).toBe(403); // token speaks for m-1 only

    // a viewer cannot register machines
    store.upsertUser({ sub: "view-1" });
    const vt = mintToken();
    store.storeToken(vt.hash, "view-1");
    const denied = await app.request("/t1/machines/register", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${vt.token}` },
      body: JSON.stringify({ id: "m-3" }),
    });
    expect(denied.status).toBe(403);
  });

  it("static-token mode gates everything on the shared secret", async () => {
    const store = new TeamStore(":memory:");
    const env = { staticToken: "s3cret" };
    expect(authMode(env)).toBe("token");
    const app = createTeamApp(store, env);
    const ingest = (auth: string | null) =>
      app.request("/t1/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify({ machine: { id: "m-1" }, records: [] }),
      });
    expect((await ingest(null)).status).toBe(401);
    expect((await ingest("wrong")).status).toBe(401);
    expect((await ingest("s3cret")).status).toBe(200);
  });

  it("open mode stays open and health reports the mode", async () => {
    const store = new TeamStore(":memory:");
    expect(principalFor(store, {}, null)).toEqual({ kind: "open" });
    const app = createTeamApp(store, {});
    const health = (await (await app.request("/t1/health")).json()) as { auth: string };
    expect(health.auth).toBe("open");
  });
});
