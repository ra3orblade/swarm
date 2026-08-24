/**
 * Org policy serving + signing (M8.3f). The team daemon holds an ed25519 keypair (generated on
 * first use, private key in team.db meta — the db IS the deployment's state); every stored policy
 * is signed, and machines verify with the public key pinned at `swarm login` (TOFU on the first
 * fetch otherwise). This closes the OQ-3 deferral: the local `policy.toml` a daemon enforces can
 * now be proven to come from the org, not edited in place.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { TeamStore } from "./store";

export { verifyPolicySignature } from "@swarm/core";

export interface SignedPolicy {
  toml: string;
  /** base64 ed25519 signature over the raw TOML bytes */
  signature: string;
  /** base64 DER (spki) public key */
  publicKey: string;
  setBy: string | null;
  createdAt: string | null;
}

/** The deployment's keypair, created once and persisted. */
export function policyKeys(store: TeamStore): { privateKeyPem: string; publicKeyB64: string } {
  let priv = store.meta("policy_private_key");
  if (!priv) {
    const kp = generateKeyPairSync("ed25519");
    priv = kp.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    store.setMetaValue("policy_private_key", priv);
  }
  const pub = createPublicKey(createPrivateKey(priv))
    .export({ format: "der", type: "spki" })
    .toString("base64");
  return { privateKeyPem: priv, publicKeyB64: pub };
}

export function signPolicy(store: TeamStore, toml: string): string {
  const { privateKeyPem } = policyKeys(store);
  return sign(null, Buffer.from(toml), createPrivateKey(privateKeyPem)).toString("base64");
}

export function setPolicy(store: TeamStore, toml: string, setBy: string): SignedPolicy {
  Bun.TOML.parse(toml); // throws on invalid TOML — the caller turns that into a 400
  const signature = signPolicy(store, toml);
  const createdAt = new Date().toISOString();
  store.db
    .query("INSERT INTO policies (toml, signature, set_by, created_at) VALUES (?, ?, ?, ?)")
    .run(toml, signature, setBy, createdAt);
  store.notify();
  return { toml, signature, publicKey: policyKeys(store).publicKeyB64, setBy, createdAt };
}

export function currentPolicy(store: TeamStore): SignedPolicy | null {
  const row = store.db
    .query("SELECT toml, signature, set_by, created_at FROM policies ORDER BY id DESC LIMIT 1")
    .get() as { toml: string; signature: string; set_by: string | null; created_at: string } | null;
  if (!row) return null;
  return {
    toml: row.toml,
    signature: row.signature,
    publicKey: policyKeys(store).publicKeyB64,
    setBy: row.set_by,
    createdAt: row.created_at,
  };
}
