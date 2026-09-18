import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OtelExporter } from "./otel";
import { Store } from "./store";

type Posted = { url: string; body: Record<string, unknown> };

function setup(extra = "") {
  const home = mkdtempSync(join(tmpdir(), "swarm-otel-"));
  writeFileSync(
    join(home, "config.toml"),
    `[otel]\nendpoint = "http://collector:4318"\ninterval = 5\n${extra}`,
  );
  const store = new Store(home);
  const posted: Posted[] = [];
  let up = true;
  const post = (async (url: string, init: RequestInit) => {
    if (!up) throw new Error("connection refused");
    posted.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const ex = new OtelExporter(store, "0.15.0", post);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "swarm-otel-cwd-")));
  const hook = (event: string, body: Record<string, unknown>) =>
    store.ingestHook(event, { session_id: "s1", cwd, ...body });
  return { store, ex, posted, hook, setUp: (v: boolean) => (up = v) };
}

describe("OTLP exporter (M12.1)", () => {
  it("starts at now, then sends finished tool calls and ended sessions once each", async () => {
    const { ex, posted, hook } = setup();
    hook("PreToolUse", { tool_name: "Bash", tool_use_id: "old", tool_input: { command: "ls" } });
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "old", tool_input: { command: "ls" } });
    let t = Date.now();
    expect(await ex.tick(t)).toBe(false); // first run only places the cursors
    expect(posted).toHaveLength(0);

    hook("SessionStart", { source: "startup" });
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_use_id: "tu1",
      tool_input: { command: "bun test" },
    });
    hook("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "tu1",
      tool_input: { command: "bun test" },
    });
    hook("SessionEnd", { reason: "exit" });
    t += 6000;
    expect(await ex.tick(t)).toBe(true);
    expect(posted.map((p) => p.url)).toEqual(["http://collector:4318/v1/traces"]);
    const body = posted[0]?.body as
      | { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }> }
      | undefined;
    const spans = body?.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans.map((s: { name: string }) => s.name).sort()).toEqual([
      "execute_tool Bash",
      "invoke_agent claude-code",
    ]);
    // the old call before the cursor is not in it, and commands stay out by default
    expect(JSON.stringify(spans)).not.toContain("old");
    expect(JSON.stringify(spans)).not.toContain("bun test");

    t += 6000;
    await ex.tick(t);
    expect(posted).toHaveLength(1); // nothing new, nothing sent
  });

  it("a failed export moves no cursor; the retry sends the same spans", async () => {
    const { ex, posted, hook, setUp, store } = setup();
    let t = Date.now();
    await ex.tick(t);
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "tu2", tool_input: { file_path: "/a" } });
    hook("PostToolUse", { tool_name: "Read", tool_use_id: "tu2", tool_input: { file_path: "/a" } });
    setUp(false);
    t += 6000;
    expect(await ex.tick(t)).toBe(false);
    expect(ex.status().lastError).toContain("connection refused");
    const before = store.metaValue("otel_seq");
    setUp(true);
    t += 60_000; // past the backoff
    expect(await ex.tick(t)).toBe(true);
    expect(store.metaValue("otel_seq")).not.toBe(before);
    expect(JSON.stringify(posted[0]?.body)).toContain("tu2");
    expect(ex.status().lastError).toBeNull();
  });

  it("does nothing without an endpoint", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-otel-off-"));
    const ex = new OtelExporter(new Store(home), "0.15.0", (() => {
      throw new Error("must not post");
    }) as unknown as typeof fetch);
    expect(await ex.tick()).toBe(false);
    expect(ex.status().configured).toBe(false);
  });
});
