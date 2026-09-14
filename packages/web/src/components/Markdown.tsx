/**
 * Markdown as elements (M11.14).
 *
 * The renderer half of `lib/markdown.ts`. It builds React nodes, never an HTML string: the text is
 * whatever a model wrote after reading whatever a tool returned, so there is no version of this
 * that goes near `dangerouslySetInnerHTML`. React escapes every string it renders, and a link's
 * `href` is checked here before it becomes one.
 *
 * Styling lives under `.md` in the stylesheet, tight enough that a rendered message still reads as
 * one row of the session log.
 */
import { type ReactNode, useMemo } from "react";
import { type Block, type Item, parse, type Span } from "../lib/markdown";

/** `javascript:` in a link an agent wrote is either a mistake or an attack; neither gets an href. */
const safeHref = (href: string): string | undefined =>
  /^(?:https?:|mailto:|#|\/)/i.test(href) ? href : undefined;

/** One run of text, wrapped in whatever marks apply to it, innermost first. */
function Run({ span }: { span: Span }) {
  let node: ReactNode = span.code ? <code>{span.text}</code> : span.text;
  if (span.strike) node = <del>{node}</del>;
  if (span.em) node = <em>{node}</em>;
  if (span.bold) node = <b>{node}</b>;
  const href = span.href ? safeHref(span.href) : undefined;
  if (href)
    node = (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {node}
      </a>
    );
  return <>{node}</>;
}

/**
 * A line of runs.
 *
 * Keyed by position: the spans are derived from immutable text, so a run's index within one parse
 * is as stable an identity as it can have — the same reasoning as the search snippet's runs.
 */
function Line({ line }: { line: Span[] }) {
  return (
    <>
      {line.map((span, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: position in an immutable parse is identity
        <Run key={i} span={span} />
      ))}
    </>
  );
}

/** Headings collapse to two levels: anything past `##` is a small heading, not a smaller one. */
const Heading = ({ level, spans }: { level: number; spans: Span[] }) =>
  level <= 2 ? (
    <h4>
      <Line line={spans} />
    </h4>
  ) : (
    <h5>
      <Line line={spans} />
    </h5>
  );

/** Written out rather than built from the depth so `check-classes` can see all three names. */
const indent = (depth: number): string | undefined =>
  depth <= 0 ? undefined : depth === 1 ? "md-in1" : depth === 2 ? "md-in2" : "md-in3";

function List({ ordered, items }: { ordered: boolean; items: Item[] }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag>
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: position in an immutable parse is identity
        <li key={i} className={indent(item.depth)}>
          <Line line={item.spans} />
        </li>
      ))}
    </Tag>
  );
}

function Table({ head, rows }: { head: Span[][]; rows: Span[][][] }) {
  return (
    <table className="md-table">
      <thead>
        <tr>
          {head.map((cell, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: position in an immutable parse is identity
            <th key={i}>
              <Line line={cell} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: position in an immutable parse is identity
          <tr key={r}>
            {row.map((cell, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: position in an immutable parse is identity
              <td key={c}>
                <Line line={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Node({ block }: { block: Block }) {
  switch (block.kind) {
    case "p":
      return (
        <p>
          <Line line={block.spans} />
        </p>
      );
    case "heading":
      return <Heading level={block.level} spans={block.spans} />;
    case "list":
      return <List ordered={block.ordered} items={block.items} />;
    case "code":
      return <pre className="md-code">{block.text}</pre>;
    case "quote":
      return (
        <blockquote>
          <Line line={block.spans} />
        </blockquote>
      );
    case "rule":
      return <hr />;
    case "table":
      return <Table head={block.head} rows={block.rows} />;
  }
}

export interface MarkdownProps {
  text: string;
  /** Added to `.md`, for a caller that needs to scope its own rules. */
  className?: string;
}

/** Render markdown text. Empty text renders nothing, not an empty box. */
export function Markdown({ text, className }: MarkdownProps) {
  const blocks = useMemo(() => parse(text), [text]);
  if (blocks.length === 0) return null;
  return (
    <div className={className ? `md ${className}` : "md"}>
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: position in an immutable parse is identity
        <Node key={i} block={block} />
      ))}
    </div>
  );
}
