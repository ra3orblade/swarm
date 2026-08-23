/**
 * Verification gates (M2.2): named checks recorded against a task — review, security, tests,
 * whatever a repo declares. Pure decision layer; the daemon persists runs.
 *
 * Invariants (docs/03, docs/10):
 *  - A run without a rubric is rejected. "Pass" with no statement of what was checked is noise.
 *  - The latest run of a gate decides its status. Failed runs are never deleted.
 *  - A task with a declared gate that has no pass is not done.
 */

export type Verdict = "pass" | "fail";

export interface GateRun {
  id: number;
  projectId: string;
  task: string;
  gate: string;
  verdict: Verdict;
  /** What was checked — required. */
  rubric: string;
  /** How it was checked: command output, PR link, notes. Optional. */
  evidence: string | null;
  sessionId: string | null;
  createdAt: string;
}

export type GateInput = Pick<GateRun, "task" | "gate" | "verdict"> & {
  rubric?: string | null | undefined;
  evidence?: string | null | undefined;
};

export type GateDecision = { ok: true } | { ok: false; reason: string };

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;

/** Validate a run before it is recorded. Fails closed on a missing rubric. */
export function validateGateRun(input: GateInput): GateDecision {
  if (!input.task?.trim()) return { ok: false, reason: "task is required" };
  if (!NAME_RE.test(input.gate ?? ""))
    return { ok: false, reason: "gate must be a short name (letters, digits, _ . -)" };
  if (input.verdict !== "pass" && input.verdict !== "fail")
    return { ok: false, reason: 'verdict must be "pass" or "fail"' };
  const rubric = input.rubric?.trim() ?? "";
  if (rubric.length < 8)
    return {
      ok: false,
      reason:
        'rubric is required: say what was checked (e.g. "tests green, no TODOs, reviewed error paths"). A verdict without a rubric is rejected.',
    };
  return { ok: true };
}

export interface GateStatus {
  gate: string;
  /** Latest run's verdict; null when the gate was declared but never run. */
  verdict: Verdict | null;
  latest: GateRun | null;
  runs: number;
  fails: number;
}

/** Per-gate status for one task: latest run wins; counts keep the history visible. */
export function gateStatus(runs: GateRun[], declared: string[] = []): GateStatus[] {
  const byGate = new Map<string, GateRun[]>();
  for (const r of runs) {
    const list = byGate.get(r.gate) ?? [];
    list.push(r);
    byGate.set(r.gate, list);
  }
  const names = [...new Set([...declared, ...byGate.keys()])];
  return names.map((gate) => {
    // Newest first; same-millisecond runs (a fail then an immediate pass) fall back to id order.
    const list = (byGate.get(gate) ?? []).sort((a, b) =>
      a.createdAt === b.createdAt ? b.id - a.id : a.createdAt < b.createdAt ? 1 : -1,
    );
    const latest = list[0] ?? null;
    return {
      gate,
      verdict: latest?.verdict ?? null,
      latest,
      runs: list.length,
      fails: list.filter((r) => r.verdict === "fail").length,
    };
  });
}

/** Every declared gate has a passing latest run. Undeclared repos (no gates) are trivially done. */
export function gatesSatisfied(runs: GateRun[], declared: string[]): boolean {
  if (!declared.length) return true;
  const st = gateStatus(runs, declared);
  return declared.every((g) => st.find((s) => s.gate === g)?.verdict === "pass");
}

/** Keep the last `max` characters of a log as gate evidence, on a line boundary when possible. */
export function evidenceTail(output: string, max = 2000): string {
  const t = output.trimEnd();
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const nl = cut.indexOf("\n");
  return `…${nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut}`;
}

/**
 * M7.4: an executed gate's outcome as a recordable run. Exit 0 passes; anything else — including
 * a timeout or a command that could not start — fails. The rubric is the command itself, so the
 * record says exactly what was checked.
 */
export function executedGateInput(
  task: string,
  gate: string,
  cmd: string,
  outcome: { exitCode: number | null; timedOut?: boolean; durationMs: number; output: string },
): GateInput {
  const how =
    outcome.timedOut === true
      ? "timed out"
      : outcome.exitCode === null
        ? "could not start"
        : `exit ${outcome.exitCode}`;
  return {
    task,
    gate,
    verdict: outcome.exitCode === 0 && !outcome.timedOut ? "pass" : "fail",
    rubric: `ran \`${cmd}\` — ${how} in ${(outcome.durationMs / 1000).toFixed(1)}s`,
    evidence: evidenceTail(outcome.output) || null,
  };
}
