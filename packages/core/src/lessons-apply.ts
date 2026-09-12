/**
 * Codify that writes (M13.6): merge a suggestion into the two files it targets.
 *
 * Pure text transforms over the existing file contents (null = the file does not exist yet):
 *  - `mergeLesson` keeps one "Lessons from Swarm" section in CLAUDE.md and adds the line once.
 *  - `mergeToml` folds a `.swarm.toml` snippet (the shapes `suggestFromIncident` emits) into an
 *    existing file: `key = value` inside a `[section]` replaces the key or adds it; a
 *    `[[section.array]]` block is appended; `[rules.protected] ports = [...]` unions the ports.
 * Everything else in the file is left byte for byte; no TOML parser, so unusual formatting is
 * preserved rather than normalised.
 */

export const LESSONS_HEADING = "## Lessons from Swarm";

export function mergeLesson(existing: string | null, lesson: string): string {
  const line = `- ${lesson.trim()}`;
  const text = existing ?? "";
  if (text.split("\n").some((l) => l.trim() === line)) return text;
  const idx = text.indexOf(LESSONS_HEADING);
  if (idx < 0) {
    const base = text.trimEnd();
    return `${base ? `${base}\n\n` : "# CLAUDE.md\n\n"}${LESSONS_HEADING}\n\n${line}\n`;
  }
  // append inside the section: before the next heading, or at the end
  const after = idx + LESSONS_HEADING.length;
  const rest = text.slice(after);
  const next = rest.search(/\n#{1,6} /);
  const cut = next < 0 ? text.length : after + next;
  const section = text.slice(after, cut).trimEnd();
  return `${text.slice(0, after)}${section}\n${line}\n${next < 0 ? "" : text.slice(cut)}`;
}

interface Block {
  /** `[rules]`, `[rules.protected]` or `[[rules.custom]]`. */
  header: string;
  array: boolean;
  lines: string[];
}

function parseSnippet(snippet: string): Block[] {
  const out: Block[] = [];
  for (const raw of snippet.split("\n")) {
    const line = raw.trimEnd();
    const h = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (h) {
      out.push({ header: line.trim(), array: line.startsWith("[["), lines: [] });
      continue;
    }
    if (!line.trim()) continue;
    const cur = out.at(-1);
    if (cur) cur.lines.push(line);
  }
  return out;
}

/** Start and end (exclusive) line indexes of a `[header]` section's body in `lines`. */
function sectionBounds(lines: string[], header: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function setKey(lines: string[], start: number, end: number, key: string, value: string): number {
  for (let i = start + 1; i < end; i++) {
    if (
      new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(lines[i] as string)
    ) {
      lines[i] = `${key} = ${value}`;
      return end;
    }
  }
  // insert before the trailing blank lines of the section
  let at = end;
  while (at > start + 1 && !(lines[at - 1] as string).trim()) at--;
  lines.splice(at, 0, `${key} = ${value}`);
  return end + 1;
}

function unionPorts(existing: string, incoming: string): string {
  const nums = (s: string) =>
    [...s.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => Number.isInteger(n));
  const set = new Set([...nums(existing), ...nums(incoming)]);
  return `[${[...set].sort((a, b) => a - b).join(", ")}]`;
}

export function mergeToml(existing: string | null, snippet: string): string {
  const lines = (existing ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 1 && lines[0] === "") lines.length = 0;
  for (const block of parseSnippet(snippet)) {
    if (block.array) {
      // a duplicate custom rule (same name) replaces nothing: it is appended for the human to see
      if (lines.length && (lines.at(-1) as string).trim() !== "") lines.push("");
      lines.push(block.header, ...block.lines);
      continue;
    }
    let bounds = sectionBounds(lines, block.header);
    if (!bounds) {
      if (lines.length && (lines.at(-1) as string).trim() !== "") lines.push("");
      lines.push(block.header);
      bounds = { start: lines.length - 1, end: lines.length };
    }
    let end = bounds.end;
    for (const l of block.lines) {
      const m = l.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const [, key, value] = m as unknown as [string, string, string];
      let v = value;
      if (block.header === "[rules.protected]" && key === "ports") {
        const cur = lines
          .slice(bounds.start + 1, end)
          .find((x) => /^\s*ports\s*=/.test(x))
          ?.split("=")[1];
        v = unionPorts(cur ?? "", value);
      }
      end = setKey(lines, bounds.start, end, key, v);
    }
  }
  const out = lines.join("\n");
  return out.endsWith("\n") ? out : `${out}\n`;
}
