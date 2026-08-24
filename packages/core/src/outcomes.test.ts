import { describe, expect, test } from "bun:test";
import type { OutcomePR, OutcomeSession } from "./outcomes";
import { outcomeReport, parseReverts } from "./outcomes";

const sess = (o: Partial<OutcomeSession>): OutcomeSession => ({
  id: "s1",
  branch: "feat/x",
  model: "claude-opus-5",
  agent: "claude-code",
  costUsd: 1,
  startedAt: "2026-08-24T10:00:00Z",
  ...o,
});
const pr = (o: Partial<OutcomePR>): OutcomePR => ({
  branch: "feat/x",
  number: 1,
  state: "merged",
  mergedAt: "2026-08-24T14:00:00Z",
  mergeSha: "a".repeat(40),
  ...o,
});

describe("parseReverts", () => {
  test("finds every reverted sha, case-normalized", () => {
    const log = `Revert "feat: x"\n\nThis reverts commit ${"A".repeat(40)}.\nAlso This reverts commit abc1234.`;
    const r = parseReverts(log);
    expect(r.has("a".repeat(40))).toBe(true);
    expect(r.has("abc1234")).toBe(true);
    expect(parseReverts("no reverts here").size).toBe(0);
  });
});

describe("outcomeReport (M9.2)", () => {
  test("merged branch: outcome, lead time from first session start, cost summed", () => {
    const r = outcomeReport(
      [
        sess({ id: "s1", costUsd: 2 }),
        sess({ id: "s2", startedAt: "2026-08-24T12:00:00Z", costUsd: 3 }),
      ],
      [pr({})],
      new Set(),
    );
    const b = r.branches[0];
    expect(b?.outcome).toBe("merged");
    expect(b?.leadHours).toBe(4); // 10:00 → 14:00
    expect(b?.costUsd).toBe(5);
    expect(b?.sessions).toEqual(["s1", "s2"]);
  });

  test("a reverted merge counts as reverted, by sha prefix either way", () => {
    const full = outcomeReport(
      [sess({})],
      [pr({})],
      parseReverts(`This reverts commit ${"a".repeat(40)}`),
    );
    expect(full.branches[0]?.outcome).toBe("reverted");
    const prefix = outcomeReport([sess({})], [pr({})], new Set(["aaaaaaa"]));
    expect(prefix.branches[0]?.outcome).toBe("reverted");
  });

  test("open PR and no PR are separated; default branches are ignored", () => {
    const r = outcomeReport(
      [
        sess({ id: "s1", branch: "feat/a" }),
        sess({ id: "s2", branch: "feat/b" }),
        sess({ id: "s3", branch: "main" }),
      ],
      [pr({ branch: "feat/a", state: "open", mergedAt: null, mergeSha: null })],
      new Set(),
    );
    expect(r.branches.map((b) => [b.branch, b.outcome]).sort()).toEqual([
      ["feat/a", "open"],
      ["feat/b", "no-pr"],
    ]);
  });

  test("dominant session (most spend) supplies model and agent", () => {
    const r = outcomeReport(
      [
        sess({ id: "cheap", model: "claude-sonnet-5", costUsd: 1 }),
        sess({ id: "big", model: "claude-opus-5", agent: "codex", costUsd: 9 }),
      ],
      [pr({})],
      new Set(),
    );
    expect(r.branches[0]?.model).toBe("claude-opus-5");
    expect(r.branches[0]?.agent).toBe("codex");
  });

  test("scorecards: merge rate over finished work only, cost per merge, median lead", () => {
    const r = outcomeReport(
      [
        sess({ id: "s1", branch: "f/1", costUsd: 4 }),
        sess({ id: "s2", branch: "f/2", costUsd: 2 }),
        sess({ id: "s3", branch: "f/3" }),
        sess({ id: "s4", branch: "f/4" }),
      ],
      [
        pr({ branch: "f/1", number: 1 }),
        pr({
          branch: "f/2",
          number: 2,
          mergedAt: "2026-08-24T20:00:00Z",
          mergeSha: "b".repeat(40),
        }),
        pr({ branch: "f/3", number: 3, mergeSha: "c".repeat(40) }),
        pr({ branch: "f/4", number: 4, state: "open", mergedAt: null, mergeSha: null }),
      ],
      new Set(["c".repeat(40)]), // f/3 reverted
    );
    const m = r.byModel[0];
    expect(m?.key).toBe("claude-opus-5");
    expect(m?.branches).toBe(4);
    expect(m?.merged).toBe(2);
    expect(m?.reverted).toBe(1);
    expect(m?.open).toBe(1);
    expect(m?.mergeRate).toBeCloseTo(2 / 3); // open work not counted against anyone
    expect(m?.medianLeadHours).toBe(7); // 4h and 10h
    expect(m?.costPerMerge).toBe(3); // $4 + $2 over 2 merges
  });

  test("merged PR wins over an open one on the same branch", () => {
    const r = outcomeReport(
      [sess({})],
      [pr({ state: "open", number: 9, mergedAt: null, mergeSha: null }), pr({ number: 3 })],
      new Set(),
    );
    expect(r.branches[0]?.outcome).toBe("merged");
    expect(r.branches[0]?.prNumber).toBe(3);
  });
});
