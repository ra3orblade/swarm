/**
 * Team auth (M8.3c). Three modes, decided by the deployment's env:
 *  - "oidc"  — SWARM_TEAM_OIDC_ISSUER + SWARM_TEAM_OIDC_CLIENT_ID set: humans log in with the
 *    OIDC device-code flow. The *team daemon* is the OAuth client (docs/14): it starts the flow,
 *    polls the issuer, verifies the ID token (RS256 against the issuer's JWKS) and issues its own
 *    opaque token — the laptop never sees an OIDC credential.
 *  - "token" — SWARM_TEAM_TOKEN set: one static shared secret for small/lab deployments.
 *  - "open"  — neither set: no auth. The scaffold default; never run this beyond a lab.
 *
 * Machine tokens are separate: `/t1/machines/register` (human-authed) mints one per machine,
 * stored hashed, bound to the registering user (OQ-19). `/t1/ingest` accepts machine auth.
 */
import type { TeamStore } from "./store";

export type AuthMode = "oidc" | "token" | "open";

export interface AuthEnv {
  issuer?: string | undefined;
  clientId?: string | undefined;
  staticToken?: string | undefined;
}

export function authEnv(env: Record<string, string | undefined> = process.env): AuthEnv {
  return {
    issuer: env.SWARM_TEAM_OIDC_ISSUER?.replace(/\/+$/, ""),
    clientId: env.SWARM_TEAM_OIDC_CLIENT_ID,
    staticToken: env.SWARM_TEAM_TOKEN,
  };
}

export function authMode(env: AuthEnv): AuthMode {
  if (env.issuer && env.clientId) return "oidc";
  if (env.staticToken) return "token";
  return "open";
}

export const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export function mintToken(): { token: string; hash: string } {
  const token = `swt_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  return { token, hash: sha256(token) };
}

/** Who a bearer token belongs to. */
export type Principal =
  | { kind: "human"; subject: string; role: string }
  | { kind: "machine"; id: string }
  | { kind: "open" };

export function principalFor(
  store: TeamStore,
  env: AuthEnv,
  bearer: string | null,
): Principal | null {
  const mode = authMode(env);
  if (mode === "open") return { kind: "open" };
  if (!bearer) return null;
  if (mode === "token")
    return bearer === env.staticToken ? { kind: "machine", id: "shared-token" } : null;
  const hash = sha256(bearer);
  const tok = store.db
    .query(
      "SELECT t.subject, u.role FROM tokens t JOIN users u ON u.subject = t.subject WHERE t.hash = ? AND (t.expires_at IS NULL OR t.expires_at > ?)",
    )
    .get(hash, new Date().toISOString()) as { subject: string; role: string } | null;
  if (tok) return { kind: "human", subject: tok.subject, role: tok.role };
  const machine = store.db.query("SELECT id FROM machines WHERE token_hash = ?").get(hash) as {
    id: string;
  } | null;
  return machine ? { kind: "machine", id: machine.id } : null;
}

// ---------- OIDC device flow (teamd is the client)

interface Discovery {
  device_authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

let discoveryCache: { issuer: string; d: Discovery; at: number } | null = null;
export async function discover(issuer: string): Promise<Discovery> {
  if (
    discoveryCache &&
    discoveryCache.issuer === issuer &&
    Date.now() - discoveryCache.at < 3_600_000
  )
    return discoveryCache.d;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const d = (await res.json()) as Discovery;
  discoveryCache = { issuer, d, at: Date.now() };
  return d;
}

export interface DeviceFlow {
  handle: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | undefined;
  interval: number;
  expiresAt: number;
}

/** In-memory pending flows: single-process daemon, short-lived by design. */
const flows = new Map<string, { deviceCode: string; interval: number; expiresAt: number }>();

export async function startDeviceFlow(env: AuthEnv): Promise<DeviceFlow> {
  if (!env.issuer || !env.clientId) throw new Error("OIDC not configured");
  const d = await discover(env.issuer);
  const res = await fetch(d.device_authorization_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.clientId, scope: "openid email profile" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`device authorization failed: ${res.status}`);
  const j = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };
  const handle = crypto.randomUUID();
  const flow = {
    deviceCode: j.device_code,
    interval: j.interval ?? 5,
    expiresAt: Date.now() + (j.expires_in ?? 600) * 1000,
  };
  flows.set(handle, flow);
  return {
    handle,
    userCode: j.user_code,
    verificationUri: j.verification_uri,
    verificationUriComplete: j.verification_uri_complete,
    interval: flow.interval,
    expiresAt: flow.expiresAt,
  };
}

export type PollResult =
  | { status: "pending" }
  | { status: "error"; error: string }
  | { status: "ok"; claims: IdClaims };

export interface IdClaims {
  sub: string;
  email?: string | undefined;
  name?: string | undefined;
}

export async function pollDeviceFlow(env: AuthEnv, handle: string): Promise<PollResult> {
  if (!env.issuer || !env.clientId) return { status: "error", error: "OIDC not configured" };
  const flow = flows.get(handle);
  if (!flow) return { status: "error", error: "unknown or expired login" };
  if (Date.now() > flow.expiresAt) {
    flows.delete(handle);
    return { status: "error", error: "login expired" };
  }
  const d = await discover(env.issuer);
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: flow.deviceCode,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json().catch(() => ({}))) as {
    error?: string;
    id_token?: string;
  };
  if (!res.ok || j.error) {
    if (j.error === "authorization_pending" || j.error === "slow_down")
      return { status: "pending" };
    flows.delete(handle);
    return { status: "error", error: j.error ?? `token endpoint ${res.status}` };
  }
  if (!j.id_token) return { status: "error", error: "issuer returned no id_token" };
  flows.delete(handle);
  const claims = await verifyIdToken(env, j.id_token);
  return { status: "ok", claims };
}

const b64url = (s: string) => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + pad, "base64");
};

/** RS256 ID-token verification against the issuer's JWKS; checks iss, aud, exp. */
export async function verifyIdToken(env: AuthEnv, idToken: string): Promise<IdClaims> {
  if (!env.issuer || !env.clientId) throw new Error("OIDC not configured");
  const [h, p, sig] = idToken.split(".");
  if (!h || !p || !sig) throw new Error("malformed id_token");
  const header = JSON.parse(b64url(h).toString()) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`unsupported id_token alg: ${header.alg}`);
  const d = await discover(env.issuer);
  const jwks = (await (
    await fetch(d.jwks_uri, { signal: AbortSignal.timeout(10_000) })
  ).json()) as {
    keys: Array<{ kid?: string; kty: string; n: string; e: string }>;
  };
  const jwk = jwks.keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) throw new Error("no matching JWKS key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64url(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("id_token signature invalid");
  const claims = JSON.parse(b64url(p).toString()) as {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    sub?: string;
    email?: string;
    name?: string;
  };
  if (claims.iss?.replace(/\/+$/, "") !== env.issuer) throw new Error("id_token issuer mismatch");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.clientId)) throw new Error("id_token audience mismatch");
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error("id_token expired");
  if (!claims.sub) throw new Error("id_token has no subject");
  return { sub: claims.sub, email: claims.email, name: claims.name };
}
