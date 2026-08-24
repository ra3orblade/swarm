import { describe, expect, it } from "bun:test";
import { parseAiderHistory, parseAiderLog } from "./history";

const FILE = `
# aider chat started at 2026-08-24 10:00:00

> Aider v0.86.1
> Model: anthropic/claude-sonnet-4 with diff edit format
> Git repo: .git with 12 files

#### fix the parser bug

Looking at the parser, the issue is the offset handling.

> Applied edit to src/parser.py
> Commit a1b2c3d fix: offset handling
> Tokens: 2.4k sent, 1.1k cache write, 800 cache hit, 156 received. Cost: $0.0058 message, $0.021 session.

#### now add a test

Added a regression test.

> Applied edit to tests/test_parser.py
> Tokens: 3.1k sent, 210 received. Cost: $0.0071 message, $0.028 session.

# aider chat started at 2026-08-24 14:30:00

> Model: gpt-4o with whole edit format

#### hello

Hi there.

> Tokens: 900 sent, 42 received.
`;

describe("aider history parser (M5.4)", () => {
  it("splits sessions, parses usage/cost/model/title/tools", () => {
    const { segments, carry } = parseAiderHistory(FILE, "/repo/.aider.chat.history.md", null);
    expect(segments.length).toBe(2);
    const a = segments[0];
    const b = segments[1];
    if (!a || !b) throw new Error("expected two segments");
    expect(a.title).toBe("fix the parser bug");
    expect(a.model).toBe("claude-sonnet-4"); // provider prefix stripped
    expect(a.turns.length).toBe(2);
    expect(a.turns[0]?.usage).toMatchObject({
      input: 1600, // 2.4k sent − 800 cache hit
      output: 156,
      cacheWrite: 1100,
      cacheRead: 800,
    });
    expect(a.turns[0]?.cost).toBeCloseTo(0.0058);
    expect(a.turns[0]?.tools).toEqual(["edit", "commit"]);
    expect(a.turns[0]?.text).toContain("offset handling");
    expect(a.turns[1]?.cost).toBeCloseTo(0.0071);
    expect(a.turns[0]?.id).not.toBe(a.turns[1]?.id);
    expect(a.sessionId).not.toBe(b.sessionId);
    // second session: cost-less usage report (free model) still closes the turn
    expect(b.model).toBe("gpt-4o");
    expect(b.turns.length).toBe(1);
    expect(b.turns[0]?.usage.input).toBe(900);
    expect(b.turns[0]?.cost).toBeNull();
    // final carry continues session b
    expect(carry?.sessionId).toBe(b.sessionId);
    expect(carry?.turns).toBe(1);
  });

  it("continues across chunks with carry (turn ids keep counting, no duplicate ids)", () => {
    const head = FILE.slice(0, FILE.indexOf("#### now add a test"));
    const tail = FILE.slice(FILE.indexOf("#### now add a test"));
    const first = parseAiderHistory(head, "/repo/.aider.chat.history.md", null);
    expect(first.segments[0]?.turns.length).toBe(1);
    const second = parseAiderHistory(tail, "/repo/.aider.chat.history.md", first.carry);
    expect(second.segments.length).toBe(2);
    expect(second.segments[0]?.sessionId).toBe(first.segments[0]?.sessionId as string);
    expect(second.segments[0]?.turns[0]?.id).toBe(`${first.segments[0]?.sessionId}-t1`);
  });

  it("handles a Cost: line that lands separately from the Tokens: line", () => {
    const chunk = `# aider chat started at 2026-08-24 09:00:00\n\n#### q\n\nanswer\n\n> Tokens: 1.0k sent, 50 received.\nCost: $0.0100 message, $0.0100 session.\n`;
    const { segments } = parseAiderHistory(chunk, "x", null);
    expect(segments[0]?.turns.length).toBe(1);
    expect(segments[0]?.turns[0]?.cost).toBeCloseTo(0.01);
  });

  it("skips content before the first header when there is no carry", () => {
    const { segments } = parseAiderHistory(
      "orphan text\n> Tokens: 1k sent, 5 received.\n",
      "x",
      null,
    );
    expect(segments.length).toBe(0);
  });

  it("parseAiderLog satisfies the adapter contract", () => {
    const r = parseAiderLog(FILE);
    expect(r.turns.length).toBe(3);
    expect(r.sessionId).toMatch(/^aider-/);
    expect(r.model).toBe("gpt-4o");
  });
});
