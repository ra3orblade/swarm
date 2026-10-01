import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";
import {
  AGENT_DOMAINS,
  sandboxDomains,
  sandboxSettings,
  sandboxViolation,
  validDomain,
} from "./sandbox";

const base = {
  worktree: "/r/.claude/worktrees/t1",
  gitCommonDir: "/r/.git",
  home: "/Users/a",
  tmpdir: "/var/folders/xy/T/",
  allowed: [] as string[],
  seeded: [] as string[],
};

describe("sandboxSettings", () => {
  test("writes are the worktree, the git dir, Claude Code's state and its temp dirs", () => {
    const s = sandboxSettings(base);
    expect(s.filesystem.allowWrite).toEqual([
      "/r/.claude/worktrees/t1",
      "/r/.git",
      "/Users/a/.claude",
      "/Users/a/.claude.json",
      "/Users/a/.claude.json.lock",
      "/Users/a/.claude.json.backup",
      "/var/folders/xy/T",
      "/tmp",
      "/private/tmp",
    ]);
    expect(s.filesystem.allowWrite).not.toContain("/r");
    expect(s.filesystem.denyRead).toContain("/Users/a/.ssh");
  });

  test("loopback stays reachable so the hooks can talk to the daemon", () => {
    expect(sandboxSettings(base).network.allowLocalBinding).toBe(true);
  });

  test("no git dir: that entry is simply absent", () => {
    const s = sandboxSettings({ ...base, gitCommonDir: null });
    expect(s.filesystem.allowWrite).not.toContain("/r/.git");
  });

  test("egress is the model API plus allowed and seeded hosts", () => {
    const s = sandboxSettings({
      ...base,
      allowed: ["registry.npmjs.org", "*.github.com"],
      seeded: ["pypi.org", "registry.npmjs.org"],
    });
    expect(s.network.allowedDomains).toEqual([
      ...AGENT_DOMAINS,
      "*.github.com",
      "pypi.org",
      "registry.npmjs.org",
    ]);
  });
});

describe("sandboxDomains", () => {
  test("drops what srt would reject instead of failing the whole run", () => {
    expect(
      sandboxDomains(["ok.dev", "bad host", "$(whoami).x", "", "API.ANTHROPIC.COM"], []),
    ).toEqual([...AGENT_DOMAINS, "ok.dev"]);
  });
  test("validDomain", () => {
    expect(validDomain("example.com")).toBe(true);
    expect(validDomain("*.example.com:8443")).toBe(true);
    expect(validDomain("localhost")).toBe(true);
    expect(validDomain("*")).toBe(false);
    expect(validDomain("a b")).toBe(false);
    expect(validDomain("http://x.com")).toBe(false);
  });
});

describe("sandboxViolation", () => {
  test("a refused write, as zsh and as Node print it", () => {
    expect(sandboxViolation("(eval):1: operation not permitted: /Users/a/x.txt")).toEqual({
      kind: "write",
      path: "/Users/a/x.txt",
    });
    expect(sandboxViolation("EPERM: operation not permitted, open '/etc/hosts'")).toEqual({
      kind: "write",
      path: "/etc/hosts",
    });
  });
  test("a refused connection, from curl and from the proxy", () => {
    expect(sandboxViolation("curl: (56) CONNECT tunnel failed, response 403")).toEqual({
      kind: "network",
      host: null,
    });
    expect(sandboxViolation("X-Proxy-Error: blocked-by-sandbox-runtime")?.kind).toBe("network");
  });
  test("ordinary failures are not violations", () => {
    expect(sandboxViolation("No such file or directory")).toBeNull();
    expect(sandboxViolation("HTTP 403 Forbidden")).toBeNull();
  });
});

describe("config", () => {
  test("off by default; [sandbox] keeps only valid domains", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(join(tmpdir(), "swarm-sbx-"));
    expect(loadConfig({ home, policy: join(home, "none.toml") }).dispatch.sandbox).toBe(false);
    writeFileSync(
      join(home, "config.toml"),
      `[dispatch]\nsandbox = true\n[sandbox]\nallowed_domains = ["Registry.npmjs.org", "not a host"]\nseed = false\n`,
    );
    const c = loadConfig({ home, policy: join(home, "none.toml") });
    expect(c.dispatch.sandbox).toBe(true);
    expect(c.sandbox).toEqual({ allowed_domains: ["registry.npmjs.org"], seed: false });
  });
});
