import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, diskVersion, VERSION } from "./app";
import { Store } from "./store";

describe("update restart (M-launch)", () => {
  it("diskVersion reads the version from the daemon entry on disk (clone layout = this tree)", () => {
    expect(diskVersion()).toBe(VERSION);
  });
  it("health reports disk + hooksInstalled; restart route 501s without a hook and fires with one", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    const none = createApp(new Store(home));
    const h = (await (await none.app.request("/v1/health")).json()) as {
      disk: string | null;
      hooksInstalled: boolean;
    };
    expect(h.disk).toBe(VERSION);
    expect(typeof h.hooksInstalled).toBe("boolean");
    expect((await none.app.request("/v1/daemon/restart", { method: "POST" })).status).toBe(501);
    let called = 0;
    const { app } = createApp(new Store(mkdtempSync(join(tmpdir(), "swarm-home-"))), {
      restart: () => called++,
    });
    const r = await app.request("/v1/daemon/restart", { method: "POST" });
    expect(((await r.json()) as { restarting: boolean }).restarting).toBe(true);
    await new Promise((res) => setTimeout(res, 120));
    expect(called).toBe(1);
  });
});
