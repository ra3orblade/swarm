import { describe, expect, test } from "bun:test";
import type { WaitKind, WaitSample } from "./waiting";
import { median, pairWaits, waitingReport } from "./waiting";

const T = (min: number, sec = 0) => new Date(Date.UTC(2026, 7, 24, 10, min, sec)).toISOString(); // 2026-08-24T10:mm:ssZ
const NOW = T(60);

const s = (phase: "start" | "end", min: number, over: Partial<WaitSample> = {}): WaitSample => ({
  sessionId: "s1",
  projectId: "p1",
  kind: "permission" as WaitKind,
  key: "r1",
  phase,
  ts: T(min),
  ...over,
});

describe("median", () => {
  test("odd takes the middle, even the mean of the middle pair", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(3); // (2+3)/2 rounded
    expect(median([])).toBe(0);
    expect(median([7])).toBe(7);
  });
});

describe("pairWaits", () => {
  test("pairs a start with its end by key", () => {
    const eps = pairWaits([s("start", 0), s("end", 5)], NOW);
    expect(eps).toHaveLength(1);
    expect(eps[0]?.ms).toBe(5 * 60_000);
    expect(eps[0]?.open).toBe(false);
    expect(eps[0]?.endedAt).toBe(T(5));
  });

  test("keys are scoped per session and kind, so concurrent waits do not cross", () => {
    const eps = pairWaits(
      [
        s("start", 0, { sessionId: "a", key: "k" }),
        s("start", 1, { sessionId: "b", key: "k" }),
        s("end", 4, { sessionId: "b", key: "k" }),
        s("end", 10, { sessionId: "a", key: "k" }),
      ],
      NOW,
    );
    const a = eps.find((e) => e.sessionId === "a");
    const b = eps.find((e) => e.sessionId === "b");
    expect(a?.ms).toBe(10 * 60_000);
    expect(b?.ms).toBe(3 * 60_000);
  });

  test("a still-open wait runs to now and is marked open", () => {
    const eps = pairWaits([s("start", 20)], NOW);
    expect(eps[0]?.open).toBe(true);
    expect(eps[0]?.endedAt).toBeNull();
    expect(eps[0]?.ms).toBe(40 * 60_000);
  });

  test("a wait open when its session ended is capped at the session end, not now", () => {
    const eps = pairWaits([s("start", 10)], NOW, { s1: T(25) });
    expect(eps[0]?.ms).toBe(15 * 60_000); // not the 50 minutes to NOW
    expect(eps[0]?.open).toBe(false);
    expect(eps[0]?.endedAt).toBe(T(25));
  });

  test("an end with no start is dropped, and a repeated start does not restart the clock", () => {
    expect(pairWaits([s("end", 5)], NOW)).toHaveLength(0);
    const eps = pairWaits([s("start", 0), s("start", 3), s("end", 6)], NOW);
    expect(eps).toHaveLength(1);
    expect(eps[0]?.ms).toBe(6 * 60_000); // from the first start
  });

  test("samples arriving out of order are ordered before pairing", () => {
    const eps = pairWaits([s("end", 8), s("start", 2)], NOW);
    expect(eps).toHaveLength(1);
    expect(eps[0]?.ms).toBe(6 * 60_000);
  });

  test("a same-instant start and end is a zero-length wait, never negative", () => {
    const eps = pairWaits([s("end", 4), s("start", 4)], NOW);
    expect(eps[0]?.ms).toBe(0);
  });
});

describe("waitingReport", () => {
  const eps = pairWaits(
    [
      // s1: a 5m permission, a 15m question, and a notification still open since T(50)
      s("start", 0),
      s("end", 5),
      s("start", 10, { kind: "question", key: "q1", label: "which branch?" }),
      s("end", 25, { kind: "question", key: "q1" }),
      s("start", 50, { kind: "notification", key: "n1", label: "needs input" }),
      // s2: one 2m permission
      s("start", 0, { sessionId: "s2", key: "r9" }),
      s("end", 2, { sessionId: "s2", key: "r9" }),
    ],
    NOW,
  );

  test("rolls up per session, ranked by blocked time", () => {
    const r = waitingReport(eps);
    expect(r.sessions.map((x) => x.sessionId)).toEqual(["s1", "s2"]);
    const s1 = r.sessions[0];
    expect(s1?.episodes).toBe(3);
    expect(s1?.blockedMs).toBe((5 + 15 + 10) * 60_000);
    expect(s1?.longestMs).toBe(15 * 60_000);
    expect(s1?.medianMs).toBe(10 * 60_000);
    expect(s1?.byKind.question.blockedMs).toBe(15 * 60_000);
    expect(s1?.byKind.permission.episodes).toBe(1);
  });

  test("names the open episode so the Fleet badge can say what is blocking", () => {
    const s1 = waitingReport(eps).sessions[0];
    expect(s1?.openSince).toBe(T(50));
    expect(s1?.openKind).toBe("notification");
    expect(s1?.openLabel).toBe("needs input");
    expect(waitingReport(eps).sessions[1]?.openSince).toBeNull();
  });

  test("totals count every episode and every session blocked right now", () => {
    const r = waitingReport(eps);
    expect(r.totals.episodes).toBe(4);
    expect(r.totals.blockedMs).toBe((5 + 15 + 10 + 2) * 60_000);
    expect(r.totals.longestMs).toBe(15 * 60_000);
    expect(r.totals.waitingNow).toBe(1);
    expect(r.totals.byKind.permission.episodes).toBe(2);
  });

  test("no episodes is a zeroed report, not a crash", () => {
    const r = waitingReport([]);
    expect(r.sessions).toEqual([]);
    expect(r.totals).toMatchObject({ episodes: 0, blockedMs: 0, medianMs: 0, waitingNow: 0 });
  });
});
