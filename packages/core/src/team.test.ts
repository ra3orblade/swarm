import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { clusterProjectKey } from "./team";

describe("clusterProjectKey (M8.3b, OQ-19)", () => {
  it("normalizes ssh, https and scp-style remotes to one key", () => {
    const key = "github.com/ra3orblade/swarm";
    expect(clusterProjectKey("git@github.com:ra3orblade/swarm.git")).toBe(key);
    expect(clusterProjectKey("https://github.com/ra3orblade/swarm.git")).toBe(key);
    expect(clusterProjectKey("https://github.com/ra3orblade/swarm")).toBe(key);
    expect(clusterProjectKey("ssh://git@github.com/ra3orblade/swarm.git")).toBe(key);
    expect(clusterProjectKey("https://user@GitHub.com/ra3orblade/swarm/")).toBe(key);
  });

  it("keeps self-hosted hosts and nested gitlab groups", () => {
    expect(clusterProjectKey("git@gitlab.example.internal:group/sub/repo.git")).toBe(
      "gitlab.example.internal/group/sub/repo",
    );
  });

  it("returns null for absent or unparseable remotes", () => {
    expect(clusterProjectKey(null)).toBeNull();
    expect(clusterProjectKey("")).toBeNull();
    expect(clusterProjectKey("not a remote")).toBeNull();
    expect(clusterProjectKey("/local/path/only")).toBeNull();
  });
});

describe("[team] config (M8.3b)", () => {
  it("defaults to no forwarding", () => {
    const c = loadConfig({ home: mkdtempSync(join(tmpdir(), "swarm-teamcfg-")) });
    expect(c.team.url).toBeNull();
    expect(c.team.forward).toEqual(["ledger", "cost"]);
    expect(c.team.interval).toBe(5);
  });
});
