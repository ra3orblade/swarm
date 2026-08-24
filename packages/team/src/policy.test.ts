import { describe, expect, it } from "bun:test";
import { verifyPolicySignature } from "@swarm/core";
import { createTeamApp } from "./app";
import { currentPolicy, policyKeys, setPolicy } from "./policy";
import { TeamStore } from "./store";

const POLICY = `locked = ["rules.destructive_git"]\n\n[rules]\ndestructive_git = "deny"\n`;

describe("signed org policy (M8.3f)", () => {
  it("signs on set; the signature verifies and tampering breaks it", () => {
    const store = new TeamStore(":memory:");
    const p = setPolicy(store, POLICY, "admin-1");
    expect(verifyPolicySignature(p.toml, p.signature, p.publicKey)).toBe(true);
    expect(verifyPolicySignature(`${p.toml}#`, p.signature, p.publicKey)).toBe(false);
    expect(verifyPolicySignature(p.toml, p.signature, "bm90LWEta2V5")).toBe(false);
    expect(currentPolicy(store)?.toml).toBe(POLICY);
  });

  it("keeps one stable keypair per deployment", () => {
    const store = new TeamStore(":memory:");
    const a = policyKeys(store).publicKeyB64;
    setPolicy(store, POLICY, "x");
    expect(policyKeys(store).publicKeyB64).toBe(a);
  });

  it("POST /t1/policy is admin-only and rejects invalid TOML; GET serves the latest", async () => {
    const store = new TeamStore(":memory:");
    store.upsertUser({ sub: "boss" }); // first user = admin
    store.upsertUser({ sub: "spectator" }); // viewer
    const { mintToken } = await import("./auth");
    const admin = mintToken();
    store.storeToken(admin.hash, "boss");
    const viewer = mintToken();
    store.storeToken(viewer.hash, "spectator");
    // oidc-ish env so auth is enforced (issuer/clientId never contacted here)
    const app = createTeamApp(store, { issuer: "http://127.0.0.1:9", clientId: "x" });
    const post = (token: string, toml: string) =>
      app.request("/t1/policy", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ toml }),
      });
    expect((await post(viewer.token, POLICY)).status).toBe(403);
    expect((await post(admin.token, "not = [ valid")).status).toBe(400);
    expect((await post(admin.token, POLICY)).status).toBe(200);
    const got = (await (
      await app.request("/t1/policy", { headers: { authorization: `Bearer ${viewer.token}` } })
    ).json()) as { policy: { toml: string; signature: string; publicKey: string } };
    expect(got.policy.toml).toBe(POLICY);
    expect(verifyPolicySignature(got.policy.toml, got.policy.signature, got.policy.publicKey)).toBe(
      true,
    );
    // the public key also rides on the open auth config for login-time pinning
    const cfg = (await (await app.request("/t1/auth/config")).json()) as {
      policyPublicKey: string;
    };
    expect(cfg.policyPublicKey).toBe(got.policy.publicKey);
  });
});
