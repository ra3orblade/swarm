/**
 * The team daemon's HTTP surface: `/t1/*` (versioned by path; see docs/14-teams.md).
 * M8.3a health; M8.3b ingest; M8.3c auth (device-code login, opaque tokens, roles, machine
 * registration); M8.3d cluster claims; M8.3e dashboard (static page + /t1/state + /t1/events
 * SSE — reusing the web package's table.js/viz.js/fm.css/icons.js). Policy (f) follows.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type AuthEnv,
  authEnv,
  authMode,
  mintToken,
  type Principal,
  pollDeviceFlow,
  principalFor,
  startDeviceFlow,
} from "./auth";
import { currentPolicy, policyKeys, setPolicy } from "./policy";
import type { TeamStore } from "./store";

export const VERSION = process.env.SWARM_VERSION ?? "0.9.0";
/** Wire-protocol version; bumped only on breaking `/t1/*` changes. */
export const PROTOCOL = 1;

type Vars = { Variables: { principal: Principal } };

/** The team page's own assets, and the shared grid/viz/css reused from the web package. */
const HERE = dirname(fileURLToPath(import.meta.url));
const TEAM_WEB = process.env.SWARM_TEAM_WEB_DIR ?? join(HERE, "../public");
const SHARED_WEB = (() => {
  if (process.env.SWARM_WEB_DIR) return process.env.SWARM_WEB_DIR;
  const dev = join(HERE, "../../web/public");
  return existsSync(join(dev, "table.js")) ? dev : join(HERE, "../web");
})();

export function createTeamApp(store: TeamStore, env: AuthEnv = authEnv()) {
  const app = new Hono<Vars>();

  // ---------- dashboard shell (static, holds no data — everything comes from authed /t1/state)
  app.get("/", (c) => c.html(readFileSync(join(TEAM_WEB, "index.html"), "utf8")));
  const MIME: Record<string, string> = { js: "text/javascript", css: "text/css" };
  app.get("/:file{[a-z0-9-]+\\.(js|css)}", (c) => {
    const f = c.req.param("file");
    const own = join(TEAM_WEB, f);
    const shared = join(SHARED_WEB, f);
    const p = existsSync(own) ? own : shared;
    if (!existsSync(p)) return c.text("not found", 404);
    return c.body(readFileSync(p, "utf8"), 200, {
      "content-type": MIME[f.split(".").pop() ?? ""] ?? "text/plain",
    });
  });

  app.get("/t1/health", (c) =>
    c.json({
      ok: true,
      version: VERSION,
      protocol: PROTOCOL,
      schema: store.schemaVersion(),
      auth: authMode(env),
    }),
  );

  // ---------- auth (M8.3c) — these routes are reachable without a token by design.
  // policyPublicKey rides here so `swarm login` pins it before the first policy fetch (M8.3f).
  app.get("/t1/auth/config", (c) =>
    c.json({
      mode: authMode(env),
      issuer: env.issuer ?? null,
      policyPublicKey: policyKeys(store).publicKeyB64,
    }),
  );

  app.post("/t1/auth/device", async (c) => {
    if (authMode(env) !== "oidc") return c.json({ error: "OIDC not configured" }, 400);
    try {
      const flow = await startDeviceFlow(env);
      return c.json(flow);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.post("/t1/auth/token", async (c) => {
    if (authMode(env) !== "oidc") return c.json({ error: "OIDC not configured" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { handle?: unknown };
    if (typeof b.handle !== "string") return c.json({ error: "handle required" }, 400);
    const r = await pollDeviceFlow(env, b.handle);
    if (r.status === "pending") return c.json({ status: "pending" });
    if (r.status === "error") return c.json({ status: "error", error: r.error }, 400);
    const user = store.upsertUser(r.claims);
    const t = mintToken();
    store.storeToken(t.hash, user.subject);
    return c.json({ status: "ok", token: t.token, subject: user.subject, role: user.role });
  });

  // ---------- everything else requires a principal (unless the deployment runs open).
  // `?token=` is accepted for the browser (SSE cannot send headers), like the local daemon.
  app.use("/t1/*", async (c, next) => {
    const auth = c.req.header("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : (c.req.query("token") ?? null);
    const p = principalFor(store, env, bearer);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", p);
    await next();
  });

  app.get("/t1/me", (c) => c.json(c.get("principal")));

  // ---------- M8.3e: the team dashboard's snapshot + live change stream
  app.get("/t1/state", (c) => c.json({ ...store.state(), version: VERSION, auth: authMode(env) }));

  app.get("/t1/events", (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      stream.onAbort(() => {
        alive = false;
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      const off = store.onChange(() => {
        if (alive) void stream.writeSSE({ event: "changed", data: "{}" });
      });
      try {
        while (alive) {
          await stream.sleep(15_000);
          if (alive) await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } finally {
        off();
      }
    }),
  );

  /** A human (developer or admin) registers a machine and receives its token (M8.3c). */
  app.post("/t1/machines/register", async (c) => {
    const p = c.get("principal");
    if (p.kind === "machine") return c.json({ error: "humans register machines" }, 403);
    const isAdmin = p.kind === "human" && p.role === "admin";
    if (p.kind === "human" && p.role === "viewer")
      return c.json({ error: "viewer role cannot register machines" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
    if (typeof b.id !== "string" || !b.id) return c.json({ error: "machine id required" }, 400);
    const owner = p.kind === "human" ? p.subject : "open";
    const existing = store.db
      .query("SELECT owner_subject FROM machines WHERE id = ?")
      .get(b.id) as { owner_subject: string | null } | null;
    if (existing?.owner_subject && existing.owner_subject !== owner && !isAdmin)
      return c.json({ error: "machine is bound to another user" }, 403);
    const t = mintToken();
    const now = new Date().toISOString();
    store.db
      .query(
        `INSERT INTO machines (id, name, token_hash, owner_subject, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, machines.name), token_hash = excluded.token_hash, owner_subject = excluded.owner_subject, last_seen = excluded.last_seen`,
      )
      .run(b.id, typeof b.name === "string" ? b.name : null, t.hash, owner, now, now);
    return c.json({ token: t.token });
  });

  // ---------- M8.3f: signed org policy — machines fetch + verify; admins set
  app.get("/t1/policy", (c) => c.json({ policy: currentPolicy(store) }));

  app.post("/t1/policy", async (c) => {
    const p = c.get("principal");
    if (!(p.kind === "open" || (p.kind === "human" && p.role === "admin")))
      return c.json({ error: "admin role required" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { toml?: unknown };
    if (typeof b.toml !== "string" || !b.toml.trim())
      return c.json({ error: "toml required" }, 400);
    try {
      return c.json({ policy: setPolicy(store, b.toml, p.kind === "human" ? p.subject : "open") });
    } catch (e) {
      return c.json({ error: `invalid TOML: ${(e as Error).message}` }, 400);
    }
  });

  // M8.3d: cluster claim register/renew — machine-authed; a token speaks for its own machine.
  app.post("/t1/claims", async (c) => {
    const p = c.get("principal");
    if (p.kind === "human") return c.json({ error: "claims sync is machine-authed" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as {
      machine?: { id?: unknown };
      claims?: unknown;
    };
    if (typeof b.machine?.id !== "string" || !b.machine.id || !Array.isArray(b.claims))
      return c.json({ error: "machine.id and claims required" }, 400);
    if (p.kind === "machine" && p.id !== "shared-token" && p.id !== b.machine.id)
      return c.json({ error: "token is for a different machine" }, 403);
    const claims = (b.claims as Array<Record<string, unknown>>)
      .filter(
        (x) =>
          typeof x.projectKey === "string" &&
          typeof x.task === "string" &&
          typeof x.acquiredAt === "string" &&
          typeof x.expiresAt === "string",
      )
      .map((x) => ({
        projectKey: x.projectKey as string,
        task: x.task as string,
        acquiredAt: x.acquiredAt as string,
        expiresAt: x.expiresAt as string,
        actor:
          x.actor && typeof (x.actor as { kind?: unknown }).kind === "string"
            ? (x.actor as { kind: string; id: string })
            : undefined,
      }));
    return c.json({ results: store.registerClaims(b.machine.id, claims) });
  });

  /** Active cluster claims (any authed principal — the team dashboard's Board). */
  app.get("/t1/claims", (c) => c.json({ claims: store.clusterClaims() }));

  // M8.3b: forwarded records from a machine's local daemon (machine-authed from M8.3c on).
  app.post("/t1/ingest", async (c) => {
    const p = c.get("principal");
    if (p.kind === "human") return c.json({ error: "ingest is machine-authed" }, 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const b = body as {
      machine?: { id?: unknown; name?: unknown; version?: unknown };
      records?: unknown;
    };
    if (typeof b.machine?.id !== "string" || !b.machine.id || !Array.isArray(b.records))
      return c.json({ error: "machine.id and records required" }, 400);
    // a machine token only speaks for its own machine id
    if (p.kind === "machine" && p.id !== "shared-token" && p.id !== b.machine.id)
      return c.json({ error: "token is for a different machine" }, 403);
    const records = (b.records as Array<Record<string, unknown>>)
      .filter((r) => r && typeof r.kind === "string" && typeof r.seq === "number")
      .map((r) => ({
        seq: r.seq as number,
        kind: r.kind as string,
        body: (r.body ?? {}) as Record<string, unknown>,
      }));
    const { ack } = store.ingest(
      {
        id: b.machine.id,
        name: typeof b.machine.name === "string" ? b.machine.name : undefined,
        version: typeof b.machine.version === "string" ? b.machine.version : undefined,
      },
      records,
    );
    return c.json({ ack });
  });

  return app;
}
