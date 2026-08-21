import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "ignore", stderr: "ignore" });
function tmpRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "swarm-mcp-repo-")));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  sh(dir, "git", "add", "README.md");
  sh(dir, "git", "commit", "-qm", "init");
  return dir;
}

const home = mkdtempSync(join(tmpdir(), "swarm-mcp-home-"));
const port = String(7900 + Math.floor(process.hrtime()[1] % 90));
const repo = tmpRepo();
let client: Client;

beforeAll(async () => {
  client = new Client({ name: "test", version: "0" });
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(import.meta.dir, "bin.ts")],
    cwd: repo,
    env: {
      ...process.env,
      SWARM_HOME: home,
      SWARM_PORT: port,
      SWARM_URL: `http://127.0.0.1:${port}`,
      SWARM_OFFLINE: "1",
      SWARM_OWNER: "agent-x",
    },
  });
  await client.connect(transport);
});
afterAll(async () => {
  await client?.close();
  try {
    const info = JSON.parse(await Bun.file(join(home, "daemon.json")).text()) as { pid: number };
    process.kill(info.pid, "SIGTERM");
  } catch {}
});

const text = (r: unknown) =>
  (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

describe("swarm-mcp", () => {
  it("exposes the claim tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "swarm_status",
        "swarm_claim",
        "swarm_release",
        "swarm_renew",
        "swarm_reap",
      ]),
    );
  });

  it("claims a task into a worktree, then fails closed on a second owner", async () => {
    const a = await client.callTool({ name: "swarm_claim", arguments: { task: "T1" } });
    expect(text(a)).toContain("claimed T1");
    expect(text(a)).toContain("worktree");

    const b = await client.callTool({
      name: "swarm_claim",
      arguments: { task: "T1", owner: "someone-else" },
    });
    expect(b.isError).toBe(true);
    expect(text(b)).toContain("REFUSED");
  });

  it("releases the claim", async () => {
    const r = await client.callTool({ name: "swarm_release", arguments: { task: "T1" } });
    expect(text(r)).toContain("released T1");
  });
});
