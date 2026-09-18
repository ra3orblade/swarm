/**
 * What a permission card shows between its title and its buttons.
 *
 * The one-line `display` is right for a Bash command or a file path. It is wrong for anything whose
 * input is structured: `AskUserQuestion` arrived as `questions=[{"question":…` cut off at eighty
 * characters, and an MCP tool as whichever argument happened to come first. Those are drawn from
 * the full `input` instead — a question as a question you can answer, the rest as named fields.
 */
import { hasOwnSummary } from "@swarm/core/adapters/claude-code/hooks";
import { type AskedQuestion, questionAnswers, unstring } from "@swarm/core/permissions";
import { type ReactNode, useState } from "react";

/** A tool call's input: the summary line where one exists, named fields where it does not. */
export function ToolInput({
  tool,
  display,
  input,
}: {
  tool: string;
  display: string;
  input: Record<string, unknown>;
}) {
  const fields = Object.entries(input);
  if (hasOwnSummary(tool) || fields.length === 0) return <div className="perm-c">{display}</div>;
  return (
    <dl className="perm-kv">
      {fields.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{fieldText(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Strings as they are; anything structured — including JSON that arrived as a string — indented. */
function fieldText(value: unknown): string {
  const v = unstring(value);
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

/**
 * The questions of an `AskUserQuestion` call, answerable in place.
 *
 * `onAnswer` receives the `answers` object the hook sends back as `updatedInput`; it is only
 * offered once every question has a pick, because a partial answer would run the tool with the
 * rest silently blank.
 */
export function QuestionForm({
  questions,
  busy,
  onAnswer,
  children,
}: {
  questions: AskedQuestion[];
  busy: boolean;
  onAnswer: (answers: Record<string, string>) => void;
  /** The card's other ways out, drawn beside Answer. */
  children?: ReactNode;
}) {
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const toggle = (q: AskedQuestion, label: string) => {
    setPicks((prev) => {
      const had = prev[q.question] ?? [];
      const next = had.includes(label)
        ? had.filter((l) => l !== label)
        : q.multiSelect
          ? [...had, label]
          : [label];
      return { ...prev, [q.question]: next };
    });
    // a single-select pick replaces whatever was typed, the way the terminal dialog does
    if (!q.multiSelect) setOther((prev) => ({ ...prev, [q.question]: "" }));
  };
  const type = (q: AskedQuestion, text: string) => {
    setOther((prev) => ({ ...prev, [q.question]: text }));
    if (!q.multiSelect && text.trim()) setPicks((prev) => ({ ...prev, [q.question]: [] }));
  };

  const answers = questionAnswers(
    Object.fromEntries(
      questions.map((q) => [q.question, [...(picks[q.question] ?? []), other[q.question] ?? ""]]),
    ),
  );
  const complete = questions.every((q) => answers[q.question]);

  return (
    <div className="perm-qs">
      {questions.map((q) => (
        <fieldset key={q.question} className="perm-q" disabled={busy}>
          <legend>
            {q.header ? <span className="perm-qh">{q.header}</span> : null}
            {q.question}
            {q.multiSelect ? <span className="dim"> — pick any</span> : null}
          </legend>
          <div className="perm-os">
            {q.options.map((o) => {
              const on = (picks[q.question] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  className={on ? "perm-o on" : "perm-o"}
                  aria-pressed={on}
                  onClick={() => toggle(q, o.label)}
                >
                  <b>{o.label}</b>
                  {o.description ? <span>{o.description}</span> : null}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            placeholder="Something else…"
            value={other[q.question] ?? ""}
            onChange={(e) => type(q, e.target.value)}
          />
        </fieldset>
      ))}
      <div className="perm-b">
        <button
          type="button"
          className="ok"
          disabled={busy || !complete}
          onClick={() => onAnswer(answers)}
        >
          Answer
        </button>
        {children}
      </div>
    </div>
  );
}
