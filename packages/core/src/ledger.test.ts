import { describe, expect, it, test } from "bun:test";
import {
  canClaim,
  canRelease,
  claimRefusalMessage,
  deriveHandoff,
  formatHandoff,
  formatResumePrompt,
  type Handoff,
  isActive,
  isAutoHandoff,
  isExpired,
  type LeaseClaim,
  nextExpiry,
  reapAction,
  shouldAutoRenew,
  validateHandoff,
} from "./ledger";

const NOW = Date.parse("2026-08-20T12:00:00Z");
const claim = (over: Partial<LeaseClaim> = {}): LeaseClaim => ({
  task: "M1.1",
  owner: "agent-a",
  worktree: "/wt/m1.1",
  branch: "task/m1.1",
  acquiredAt: "2026-08-20T11:30:00Z",
  expiresAt: "2026-08-20T12:15:00Z",
  state: "held",
  ...over,
});

describe("leases", () => {
  it("expiry and active reflect the clock", () => {
    expect(isExpired(claim(), NOW)).toBe(false);
    expect(isExpired(claim({ expiresAt: "2026-08-20T11:59:00Z" }), NOW)).toBe(true);
    expect(isActive(claim(), NOW)).toBe(true);
    expect(isActive(claim({ state: "released" }), NOW)).toBe(false);
  });
  it("nextExpiry advances by the lease", () => {
    expect(nextExpiry(NOW, 45)).toBe("2026-08-20T12:45:00.000Z");
  });
});

describe("canClaim (fail closed)", () => {
  it("blocks a second owner on an active task", () => {
    const d = canClaim([claim()], "M1.1", "agent-b", NOW);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.heldBy).toBe("agent-a");
      expect(claimRefusalMessage(d, "M1.1")).toContain("held by agent-a");
    }
  });
  it("lets the same owner re-claim their own active task", () => {
    expect(canClaim([claim()], "M1.1", "agent-a", NOW).ok).toBe(true);
  });
  it("an expired claim never blocks", () => {
    expect(
      canClaim([claim({ expiresAt: "2026-08-20T11:00:00Z" })], "M1.1", "agent-b", NOW).ok,
    ).toBe(true);
  });
  it("a free task is claimable", () => {
    expect(canClaim([], "M2.3", "agent-a", NOW).ok).toBe(true);
  });
});

describe("canRelease (refuses to lose work)", () => {
  it("refuses dirty and unpushed unless forced", () => {
    expect(canRelease({ dirty: true, unpushed: false }, false)).toEqual({
      ok: false,
      reason: "dirty",
    });
    expect(canRelease({ dirty: false, unpushed: true }, false)).toEqual({
      ok: false,
      reason: "unpushed",
    });
    expect(canRelease({ dirty: true, unpushed: true }, true).ok).toBe(true);
  });
  it("clean worktrees release freely", () => {
    expect(canRelease({ dirty: false, unpushed: false }, false).ok).toBe(true);
  });
});

describe("reapAction (never loses work unattended)", () => {
  const expired = claim({ expiresAt: "2026-08-20T11:00:00Z" });
  it("leaves active claims alone", () => {
    expect(reapAction(claim(), NOW, true, { dirty: false, unpushed: false })).toBe("not-expired");
  });
  it("reaps expired claims whose worktree is gone or clean", () => {
    expect(reapAction(expired, NOW, false, null)).toBe("reap");
    expect(reapAction(expired, NOW, true, { dirty: false, unpushed: false })).toBe("reap");
  });
  it("keeps an expired claim whose worktree still holds work (never invisible)", () => {
    expect(reapAction(expired, NOW, true, { dirty: true, unpushed: false })).toBe("keep-orphaned");
    expect(reapAction(expired, NOW, true, { dirty: false, unpushed: true })).toBe("keep-orphaned");
  });
});

describe("auto-renew (M1.2)", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const at = (min: number) => new Date(now + min * 60_000).toISOString();
  it("renews only a held claim past half its lease, never an expired one", () => {
    expect(shouldAutoRenew({ state: "held", expiresAt: at(40) }, now)).toBe(false); // fresh
    expect(shouldAutoRenew({ state: "held", expiresAt: at(22) }, now)).toBe(true); // < 22.5 left
    expect(shouldAutoRenew({ state: "held", expiresAt: at(1) }, now)).toBe(true);
    expect(shouldAutoRenew({ state: "held", expiresAt: at(-1) }, now)).toBe(false); // expired
    expect(shouldAutoRenew({ state: "released", expiresAt: at(5) }, now)).toBe(false);
    expect(shouldAutoRenew({ state: "held", expiresAt: at(25) }, now, 60)).toBe(true); // 60-min lease
  });
});

describe("handoffs (M1.3)", () => {
  it("needs done + remaining; formats compactly", () => {
    expect(validateHandoff({ task: "t", done: "x" }).ok).toBe(false);
    expect(validateHandoff({ task: "", done: "x", remaining: "y" }).ok).toBe(false);
    expect(validateHandoff({ task: "t", done: "x", remaining: "y" }).ok).toBe(true);
    const txt = formatHandoff({
      task: "M1.3",
      done: "table + routes",
      remaining: "CLI, MCP, docs",
      files: ["store.ts", "app.ts"],
      verify: "bun test",
      by: "alice",
      createdAt: "2026-08-22T15:00:00.000Z",
    });
    expect(txt).toBe(
      "[swarm] handoff on M1.3 from alice (2026-08-22 15:00):\n  done: table + routes\n  remaining: CLI, MCP, docs\n  files: store.ts, app.ts\n  verify: bun test",
    );
  });
});

describe("deriveHandoff (M4.4)", () => {
  const t = (tool: string, arg: string) => ({
    type: "tool.requested",
    payload: { hook: "PreToolUse", tool, summary: `${tool} ${arg}` },
  });
  const prompt = (p: string) => ({
    type: "prompt.submitted",
    payload: { hook: "UserPromptSubmit", summary: p.slice(0, 120), prompt: p },
  });

  test("collects edited files, the last verify command and the last prompt", () => {
    const h = deriveHandoff(
      "T-1",
      [
        prompt("add the thing"),
        t("Read", "a.ts"),
        t("Edit", "a.ts"),
        t("Write", "b.ts"),
        t("Bash", "git status"),
        t("Bash", "bun test packages/core"),
        t("Bash", "bun run lint"),
        t("Edit", "a.ts"),
        prompt("now fix lint\nsecond line"),
      ],
      {
        lastText: "Fixed  the   lint\nerrors.",
        sessionId: "abcdefgh-123",
        now: "2026-08-22T10:00:00Z",
      },
    );
    expect(h).not.toBeNull();
    expect(h?.files).toEqual(["a.ts", "b.ts"]);
    expect(h?.verify).toBe("bun run lint");
    expect(h?.done).toBe("Fixed the lint errors.");
    expect(h?.remaining).toContain('last request: "now fix lint"');
    expect(h?.by).toBe("auto:abcdefgh");
    expect(isAutoHandoff(h as Handoff)).toBe(true);
    expect(validateHandoff(h as Handoff).ok).toBe(true);
  });

  test("returns null when the session touched nothing and said nothing", () => {
    expect(deriveHandoff("T-1", [t("Read", "a.ts"), t("Bash", "ls")], {})).toBeNull();
  });

  test("falls back to a count when nothing was said", () => {
    const h = deriveHandoff("T-1", [t("Edit", "x.ts")], {});
    expect(h?.done).toBe("edited 1 file (no summary)");
    expect(h?.remaining).toContain("without a manual handoff");
    expect(h?.verify).toBeNull();
    expect(isAutoHandoff({ by: "alice" })).toBe(false);
  });

  test("formatResumePrompt puts the handoff first and the tail oldest-first", () => {
    const h = deriveHandoff("T-1", [t("Edit", "x.ts")], { now: "2026-08-22T10:00:00Z" }) as Handoff;
    const p = formatResumePrompt(h, ["Edit x.ts", "Bash bun test"]);
    expect(p.startsWith("You are resuming T-1")).toBe(true);
    expect(p.indexOf("[swarm] handoff on T-1")).toBeLessThan(p.indexOf("  - Edit x.ts"));
    expect(p.indexOf("  - Edit x.ts")).toBeLessThan(p.indexOf("  - Bash bun test"));
    expect(p).toContain("swarm_handoff");
  });
});
