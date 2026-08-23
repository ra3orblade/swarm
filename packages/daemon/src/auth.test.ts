import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureToken, readToken } from "@swarm/client";
import { createApp } from "./app";
import { Store } from "./store";

describe("daemon token (M8.2b)", () => {
  it("ensureToken creates a 0600 hex secret once", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    const t = ensureToken(home);
    expect(t).toMatch(/^[a-f0-9]{64}$/);
    expect(ensureToken(home)).toBe(t);
    expect(readToken(home)).toBe(t);
    expect(readFileSync(join(home, "token"), "utf8").trim()).toBe(t);
  });

  it("loopback-optional: no token works; a wrong token is refused; the right token works", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    const t = ensureToken(home);
    const { app } = createApp(new Store(home));
    expect((await app.request("/v1/projects")).status).toBe(200);
    expect(
      (await app.request("/v1/projects", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect(
      (await app.request("/v1/projects", { headers: { authorization: `Bearer ${t}` } })).status,
    ).toBe(200);
    expect((await app.request(`/v1/events?since=0&token=${t}`)).status).toBe(200);
  });

  it("required: every /v1 call except health needs the token, even from loopback", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    writeFileSync(join(home, "config.toml"), '[daemon]\nauth = "required"\n');
    const t = ensureToken(home);
    const { app } = createApp(new Store(home));
    expect((await app.request("/v1/health")).status).toBe(200);
    expect(((await (await app.request("/v1/health")).json()) as { auth: string }).auth).toBe(
      "required",
    );
    expect((await app.request("/v1/projects")).status).toBe(401);
    expect(
      (await app.request("/v1/projects", { headers: { authorization: `Bearer ${t}` } })).status,
    ).toBe(200);
  });

  it("a non-loopback peer is refused without the token regardless of mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    ensureToken(home);
    const { app } = createApp(new Store(home));
    const env = { requestIP: () => ({ address: "10.0.0.9" }) };
    expect((await app.request("/v1/projects", {}, env)).status).toBe(401);
  });
});
