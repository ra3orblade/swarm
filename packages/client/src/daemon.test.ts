import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "harness-daemon-"));
process.env.HARNESS_HOME = home;
delete process.env.HARNESS_URL;

const { clearDaemonInfo, daemonCommand, readDaemonInfo, resolveBaseUrl, writeDaemonInfo } =
  await import("./daemon");

afterEach(() => clearDaemonInfo());

describe("daemon info", () => {
  it("round-trips daemon.json and derives the url", () => {
    expect(readDaemonInfo()).toBeNull();
    const info = writeDaemonInfo({ port: 7788, pid: 123, version: "9.9.9", startedAt: "t" });
    expect(info.url).toBe("http://127.0.0.1:7788");
    expect(readDaemonInfo()?.pid).toBe(123);
    clearDaemonInfo();
    expect(readDaemonInfo()).toBeNull();
  });

  it("resolveBaseUrl falls back to daemon.json then default", () => {
    writeDaemonInfo({ port: 7799, pid: 1, version: "x", startedAt: "t" });
    expect(resolveBaseUrl()).toBe("http://127.0.0.1:7799");
    clearDaemonInfo();
    expect(resolveBaseUrl()).toBe("http://127.0.0.1:7777");
    expect(resolveBaseUrl("http://x:1/")).toBe("http://x:1");
  });

  it("resolves a daemon command (source bin in dev, harnessd otherwise)", () => {
    const cmd = daemonCommand();
    expect(cmd.length).toBeGreaterThan(0);
    expect(cmd[0] === "bun" || cmd[0] === "harnessd").toBe(true);
  });
});
