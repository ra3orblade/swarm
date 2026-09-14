/**
 * Markdown, parsed to values (M11.14).
 *
 * Everything an agent says is markdown — bullets, `code`, **bold**, fenced blocks, the occasional
 * table — and until now the dashboard showed the source. A log row read
 * "**Done.** Fixed `store.ts`:" with the asterisks and backticks in it, and a fenced block was a
 * wall of text with ``` on both ends.
 *
 * This is a parser, not a renderer: it returns blocks and spans, and `components/Markdown.tsx`
 * turns them into elements. Two reasons. It is testable without a DOM, and it never produces an
 * HTML string — turn text comes from a model reading whatever a tool returned, so the one thing
 * this must never do is hand `dangerouslySetInnerHTML` something that came off the wire.
 *
 * It is a deliberate subset: what agents actually write, not CommonMark. No setext headings, no
 * reference links, no inline HTML (which is passed through as text, and so escaped by React).
 */

/** One run of inline text, with the marks that apply to it. A link carries its `href`. */
export interface Span {
  text: string;
  code?: true;
  bold?: true;
  em?: true;
  strike?: true;
  href?: string;
}

/** One list item: its spans, and how deeply it was indented. */
export interface Item {
  depth: number;
  spans: Span[];
}

export type Block =
  | { kind: "p"; spans: Span[] }
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Item[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "quote"; spans: Span[] }
  | { kind: "rule" }
  | { kind: "table"; head: Span[][]; rows: Span[][][] };

// ---- inline ------------------------------------------------------------------------------------

/**
 * The inline marks, in the order they must be tried.
 *
 * Order is the whole design here. Code first, so `**` inside a span of code stays literal. Then
 * links, so a URL containing an underscore is not read as emphasis. Then the two-character marks
 * before their one-character prefixes, or `**bold**` matches as an empty `*` emphasis.
 */
const INLINE: readonly { re: RegExp; mark: keyof Span | "link" }[] = [
  { re: /`([^`]+)`/, mark: "code" },
  { re: /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, mark: "link" },
  { re: /\*\*([^*]+)\*\*/, mark: "bold" },
  { re: /__([^_]+)__/, mark: "bold" },
  { re: /~~([^~]+)~~/, mark: "strike" },
  { re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/, mark: "em" },
  { re: /(?<![_\w])_([^_\n]+)_(?![_\w])/, mark: "em" },
];

/** A bare URL, so `see https://example.com` is clickable without being written as a link. */
const BARE_URL = /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/;

/** How deep emphasis inside emphasis is followed before the rest is taken as plain text. */
const MAX_DEPTH = 4;

function withMark(spans: Span[], mark: keyof Span): Span[] {
  return spans.map((span) => ({ ...span, [mark]: true }) as Span);
}

/**
 * Split one line of text into marked runs.
 *
 * Finds the earliest match of any mark, keeps what came before as plain text, recurses into the
 * match's contents (so `**bold `code`**` keeps both marks) and continues after it. A mark whose
 * contents are themselves only text costs one shallow call; nothing here backtracks.
 */
export function spans(text: string, depth = 0): Span[] {
  if (!text) return [];
  if (depth >= MAX_DEPTH) return [{ text }];

  let best: { at: number; length: number; span: Span[] } | null = null;
  const consider = (at: number, length: number, span: Span[]) => {
    if (at < 0 || (best && best.at <= at)) return;
    best = { at, length, span };
  };

  for (const { re, mark } of INLINE) {
    const m = re.exec(text);
    if (!m) continue;
    const inner = m[1] ?? "";
    if (mark === "code") consider(m.index, m[0].length, [{ text: inner, code: true }]);
    else if (mark === "link") {
      const href = m[2] as string;
      consider(m.index, m[0].length, [{ text: inner || href, href }]);
    } else consider(m.index, m[0].length, withMark(spans(inner, depth + 1), mark));
  }
  const url = BARE_URL.exec(text);
  if (url) consider(url.index, url[0].length, [{ text: url[0], href: url[0] }]);

  if (!best) return [{ text }];
  const { at, length, span } = best as { at: number; length: number; span: Span[] };
  const before = at > 0 ? [{ text: text.slice(0, at) }] : [];
  return [...before, ...span, ...spans(text.slice(at + length), depth)];
}

// ---- blocks ------------------------------------------------------------------------------------

const FENCE = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** Two spaces of indent per level, so a sub-bullet nests and an over-indented one does not run away. */
const indentDepth = (spaces: string): number => Math.min(3, Math.floor(spaces.length / 2));

const cells = (row: string): Span[][] =>
  row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => spans(cell.trim()));

/** What a line can be added to: the paragraph being gathered, or the list being gathered. */
interface Open {
  blocks: Block[];
  para: string[];
  list: { ordered: boolean; items: Item[] } | null;
}

/** Close whatever is open. A paragraph and a list never coexist, but closing both is honest. */
function flush(open: Open): void {
  if (open.para.length > 0) open.blocks.push({ kind: "p", spans: spans(open.para.join(" ")) });
  open.para = [];
  if (open.list) open.blocks.push({ kind: "list", ...open.list });
  open.list = null;
}

/**
 * A fenced code block, if the line opens one. Returns the line it ends on.
 *
 * An unterminated fence closes at the end of the text: half a code block is better than the rest
 * of the message disappearing into one.
 */
function takeFence(lines: string[], i: number, open: Open): number | null {
  const fence = FENCE.exec(lines[i] as string);
  if (!fence) return null;
  flush(open);
  const body: string[] = [];
  let j = i + 1;
  for (; j < lines.length && !FENCE.test(lines[j] as string); j++) body.push(lines[j] as string);
  open.blocks.push({ kind: "code", lang: fence[1] || null, text: body.join("\n") });
  return j;
}

/** A table, if the line starts one. Only a row with a divider under it counts; `| x |` is prose. */
function takeTable(lines: string[], i: number, open: Open): number | null {
  const line = lines[i] as string;
  if (!TABLE_ROW.test(line) || !TABLE_DIVIDER.test(lines[i + 1] ?? "")) return null;
  flush(open);
  const rows: Span[][][] = [];
  let j = i + 2;
  for (; j < lines.length && TABLE_ROW.test(lines[j] as string); j++)
    rows.push(cells(lines[j] as string));
  open.blocks.push({ kind: "table", head: cells(line), rows });
  return j - 1;
}

/** A blank line, a rule, a heading or a quote — each of which closes whatever was open. */
function takeLeaf(line: string, open: Open): boolean {
  if (!line.trim()) {
    flush(open);
    return true;
  }
  if (RULE.test(line)) {
    flush(open);
    open.blocks.push({ kind: "rule" });
    return true;
  }
  const heading = HEADING.exec(line);
  if (heading) {
    flush(open);
    open.blocks.push({
      kind: "heading",
      level: (heading[1] as string).length,
      spans: spans(heading[2] as string),
    });
    return true;
  }
  const quote = QUOTE.exec(line);
  if (!quote) return false;
  flush(open);
  open.blocks.push({ kind: "quote", spans: spans(quote[1] as string) });
  return true;
}

/** A list item. Switching between bullets and numbers starts a new list rather than mixing them. */
function takeItem(line: string, open: Open): boolean {
  const bullet = BULLET.exec(line);
  const numbered = bullet ? null : NUMBERED.exec(line);
  const item = bullet ?? numbered;
  if (!item) return false;
  if (open.para.length > 0) flush(open);
  const ordered = numbered !== null;
  if (open.list && open.list.ordered !== ordered) flush(open);
  open.list ??= { ordered, items: [] };
  open.list.items.push({ depth: indentDepth(item[1] as string), spans: spans(item[2] as string) });
  return true;
}

/** Anything else is text: a continuation of the open list item, or of the open paragraph. */
function takeText(line: string, open: Open): void {
  const last = open.list?.items.at(-1);
  if (last && /^\s/.test(line)) {
    last.spans = [...last.spans, { text: " " }, ...spans(line.trim())];
    return;
  }
  if (open.list) flush(open);
  open.para.push(line.trim());
}

/**
 * Parse markdown into blocks.
 *
 * Line-oriented and single-pass: each line either continues the block being built or closes it and
 * starts another. Consecutive plain lines join into one paragraph, which is what makes a wrapped
 * sentence render as a sentence rather than as one paragraph per newline.
 */
export function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const open: Open = { blocks: [], para: [], list: null };
  for (let i = 0; i < lines.length; i++) {
    const fenced = takeFence(lines, i, open);
    if (fenced !== null) {
      i = fenced;
      continue;
    }
    const tabled = takeTable(lines, i, open);
    if (tabled !== null) {
      i = tabled;
      continue;
    }
    const line = lines[i] as string;
    if (takeLeaf(line, open) || takeItem(line, open)) continue;
    takeText(line, open);
  }
  flush(open);
  return open.blocks;
}

// ---- one line ----------------------------------------------------------------------------------

/**
 * Markdown reduced to the words in it, on one line.
 *
 * For the places that have room for a sentence and no more — a table cell, a tooltip, the "now"
 * column on Fleet. Rendering marks there would be worse than showing none: a `<b>` inside a
 * one-line cell just makes the cell noisier. So the marks come off and the text stays.
 */
export function plain(source: string): string {
  return source
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(
      /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (_m, label: string, url: string) => label || url,
    )
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first non-empty line of a message, with its markdown taken off. */
export function firstLine(source: string): string {
  for (const line of source.split("\n")) {
    const text = plain(line);
    if (text) return text;
  }
  return "";
}
