/**
 * The markdown subset, pinned by the shapes agents actually emit.
 *
 * These are the cases that decide whether a log row reads as a message or as its source: a fenced
 * block that swallows the rest of the text, a `**` that matches as emphasis, a bullet list broken
 * into one paragraph per line.
 */
import { describe, expect, test } from "bun:test";
import { type Block, firstLine, parse, plain, type Span, spans } from "./markdown";

const text = (list: Span[]): string => list.map((s) => s.text).join("");
const kinds = (blocks: Block[]): string[] => blocks.map((b) => b.kind);

describe("spans", () => {
  test("plain text is one run", () => {
    expect(spans("just words")).toEqual([{ text: "just words" }]);
  });

  test("bold, emphasis, code and strike each mark their run", () => {
    expect(spans("**b** *i* `c` ~~s~~")).toEqual([
      { text: "b", bold: true },
      { text: " " },
      { text: "i", em: true },
      { text: " " },
      { text: "c", code: true },
      { text: " " },
      { text: "s", strike: true },
    ]);
  });

  test("code wins over the marks inside it", () => {
    expect(spans("`a ** b`")).toEqual([{ text: "a ** b", code: true }]);
  });

  test("two stars are bold, never an empty emphasis", () => {
    const marked = spans("**done**");
    expect(marked).toHaveLength(1);
    expect(marked[0]?.bold).toBe(true);
  });

  test("marks nest", () => {
    expect(spans("**bold `code`**")).toEqual([
      { text: "bold ", bold: true },
      { text: "code", code: true, bold: true },
    ]);
  });

  test("an underscore inside a word is not emphasis", () => {
    expect(spans("swarm_teamd is one word")).toEqual([{ text: "swarm_teamd is one word" }]);
  });

  test("links carry their href, and a bare URL becomes one", () => {
    expect(spans("[docs](https://x.dev/a)")).toEqual([{ text: "docs", href: "https://x.dev/a" }]);
    expect(spans("see https://x.dev/a.")).toEqual([
      { text: "see " },
      { text: "https://x.dev/a", href: "https://x.dev/a" },
      { text: "." },
    ]);
  });
});

describe("parse", () => {
  test("wrapped lines join into one paragraph", () => {
    const blocks = parse("one line\nand its continuation\n\nsecond paragraph");
    expect(kinds(blocks)).toEqual(["p", "p"]);
    expect(text((blocks[0] as { spans: Span[] }).spans)).toBe("one line and its continuation");
  });

  test("a bullet list is one block, not a paragraph per line", () => {
    const blocks = parse("- one\n- two\n- three");
    expect(kinds(blocks)).toEqual(["list"]);
    const list = blocks[0] as Extract<Block, { kind: "list" }>;
    expect(list.ordered).toBe(false);
    expect(list.items.map((i) => text(i.spans))).toEqual(["one", "two", "three"]);
  });

  test("indentation nests, and a numbered list is its own block", () => {
    const blocks = parse("- top\n  - under\n\n1. first\n2. second");
    const bullets = blocks[0] as Extract<Block, { kind: "list" }>;
    expect(bullets.items.map((i) => i.depth)).toEqual([0, 1]);
    expect((blocks[1] as Extract<Block, { kind: "list" }>).ordered).toBe(true);
  });

  test("a fenced block keeps its text verbatim and its language", () => {
    const blocks = parse("before\n```ts\nconst a = 1;\n\n**not bold**\n```\nafter");
    expect(kinds(blocks)).toEqual(["p", "code", "p"]);
    const code = blocks[1] as Extract<Block, { kind: "code" }>;
    expect(code.lang).toBe("ts");
    expect(code.text).toBe("const a = 1;\n\n**not bold**");
  });

  test("an unterminated fence still closes at the end of the message", () => {
    const blocks = parse("```\nhalf a block");
    expect(kinds(blocks)).toEqual(["code"]);
    expect((blocks[0] as Extract<Block, { kind: "code" }>).text).toBe("half a block");
  });

  test("headings, quotes and rules", () => {
    expect(kinds(parse("## Title\n\n> quoted\n\n---"))).toEqual(["heading", "quote", "rule"]);
    expect((parse("### deep")[0] as Extract<Block, { kind: "heading" }>).level).toBe(3);
  });

  test("a table needs its divider; without one it is prose", () => {
    const table = parse("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(kinds(table)).toEqual(["table"]);
    const t = table[0] as Extract<Block, { kind: "table" }>;
    expect(t.head.map(text)).toEqual(["a", "b"]);
    expect(t.rows).toHaveLength(1);
    expect(kinds(parse("| not a table |"))).toEqual(["p"]);
  });

  test("empty text is no blocks at all", () => {
    expect(parse("")).toEqual([]);
    expect(parse("\n\n  \n")).toEqual([]);
  });
});

describe("plain", () => {
  test("takes the marks off and keeps the words", () => {
    expect(plain("**Done.** Fixed `store.ts` — see [docs](https://x.dev)")).toBe(
      "Done. Fixed store.ts — see docs",
    );
  });

  test("drops fences, bullets and headings", () => {
    expect(plain("# Title\n\n- one\n- two\n\n```ts\ncode()\n```")).toBe("Title one two");
  });

  test("a link with no label falls back to its url", () => {
    expect(plain("[](https://x.dev/a)")).toBe("https://x.dev/a");
  });

  test("firstLine is the first line that has words in it", () => {
    expect(firstLine("\n\n## Summary\nthe rest")).toBe("Summary");
    expect(firstLine("   ")).toBe("");
  });
});
