/**
 * Review as a gate (M7.9): `[gates.review] builtin = "review"` makes the daemon spawn a read-only
 * `claude -p` over the worktree's diff with a fixed rubric and record pass/fail + findings as the
 * gate's evidence. This module is the pure part — prompt, argv, verdict parsing, gate input.
 */
import type { GateInput } from "./gates";

export interface ReviewFinding {
  file: string;
  line?: number | null;
  severity: "blocker" | "major" | "minor" | "nit";
  summary: string;
}
export interface ReviewVerdict {
  verdict: "pass" | "fail";
  summary: string;
  findings: ReviewFinding[];
}

/** What a pass means. Stable wording: it is the rubric recorded on every run. */
export const REVIEW_RUBRIC =
  "review: no blocker/major findings — correctness bugs, data loss, security, broken invariants (never kill by pattern, never touch a worktree you don't hold, repo-agnostic), missing tests for changed behaviour";

export const REVIEW_PATCH_MAX = 120_000;

export function reviewPrompt(input: {
  task: string;
  title?: string | null;
  branch?: string | null;
  stat: string;
  patch: string;
}): string {
  const patch =
    input.patch.length > REVIEW_PATCH_MAX
      ? `${input.patch.slice(0, REVIEW_PATCH_MAX)}\n\n[… patch truncated at ${REVIEW_PATCH_MAX} chars; read the files for the rest]`
      : input.patch;
  return [
    `You are the review gate for task ${input.task}${input.title ? ` — ${input.title}` : ""}${input.branch ? ` (branch ${input.branch})` : ""}.`,
    "You are read-only: you may Read, Grep and Glob files in this worktree to understand context. Do not edit anything.",
    "",
    "Judge the diff below against this rubric and nothing else:",
    `- ${REVIEW_RUBRIC}`,
    "- A finding is a concrete defect with a file and, when possible, a line — not style, not preference.",
    "- Severity: blocker (must not merge), major (should not merge), minor (worth fixing), nit.",
    '- verdict is "fail" if and only if there is at least one blocker or major finding.',
    "",
    "Respond with ONLY a JSON object, no prose, no code fence:",
    '{"verdict":"pass"|"fail","summary":"one sentence","findings":[{"file":"path","line":123,"severity":"blocker|major|minor|nit","summary":"what is wrong and why"}]}',
    "",
    "Files changed:",
    input.stat.trim() || "(no stat)",
    "",
    "Diff:",
    patch.trim() || "(empty diff)",
  ].join("\n");
}

/** argv for `claude` — read-only, non-interactive, JSON envelope. */
export function reviewArgs(prompt: string, opts: { model?: string | null } = {}): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "LS",
    "--disallowedTools",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "Bash",
    "WebFetch",
    "WebSearch",
    "--permission-mode",
    "dontAsk",
  ];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/** Parse the reviewer's stdout: the `claude -p --output-format json` envelope or bare text. */
export function parseReviewVerdict(stdout: string): ReviewVerdict | null {
  let text = stdout.trim();
  try {
    const env = JSON.parse(text) as { result?: unknown };
    if (env && typeof env === "object" && typeof env.result === "string") text = env.result.trim();
  } catch {
    /* not an envelope */
  }
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const findings: ReviewFinding[] = Array.isArray(o.findings)
    ? o.findings
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .map((f) => ({
          file: String(f.file ?? "").slice(0, 300),
          line: Number.isInteger(f.line) ? (f.line as number) : null,
          severity: (["blocker", "major", "minor", "nit"].includes(String(f.severity))
            ? String(f.severity)
            : "minor") as ReviewFinding["severity"],
          summary: String(f.summary ?? "").slice(0, 600),
        }))
        .filter((f) => f.summary)
    : [];
  const serious = findings.some((f) => f.severity === "blocker" || f.severity === "major");
  // the rubric decides, not the model's self-reported verdict — they agree unless the JSON is sloppy
  const verdict: "pass" | "fail" = serious ? "fail" : o.verdict === "fail" ? "fail" : "pass";
  return { verdict, summary: String(o.summary ?? "").slice(0, 400), findings };
}

/** The gate run to record for a review outcome (or a reviewer that failed to answer). */
export function reviewGateInput(
  task: string,
  gate: string,
  outcome:
    | { kind: "verdict"; verdict: ReviewVerdict; durationMs: number }
    | { kind: "error"; reason: string; durationMs: number; output?: string },
): GateInput {
  if (outcome.kind === "error")
    return {
      task,
      gate,
      verdict: "fail",
      rubric: REVIEW_RUBRIC,
      evidence: `reviewer did not answer: ${outcome.reason}${outcome.output ? `\n${outcome.output.slice(-1500)}` : ""}`,
    };
  const v = outcome.verdict;
  const lines = v.findings.map(
    (f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.summary}`,
  );
  const secs = (outcome.durationMs / 1000).toFixed(0);
  return {
    task,
    gate,
    verdict: v.verdict,
    rubric: REVIEW_RUBRIC,
    evidence: `${v.summary || (v.verdict === "pass" ? "no blocking findings" : "blocking findings")} (${v.findings.length} finding${v.findings.length === 1 ? "" : "s"}, ${secs}s)${lines.length ? `\n${lines.join("\n")}` : ""}`,
  };
}
