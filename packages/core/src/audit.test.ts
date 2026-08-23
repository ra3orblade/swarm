import { describe, expect, test } from "bun:test";
import {
  auditRow,
  compileRedactions,
  formatAudit,
  isAuditType,
  redactValue,
  sinceToIso,
} from "./audit";

describe("audit (M8.2c)", () => {
  test("audit types: ledger + decisions in, chatter out", () => {
    expect(isAuditType("claim.acquired")).toBe(true);
    expect(isAuditType("incident.acked")).toBe(true);
    expect(isAuditType("tool.requested")).toBe(false);
    expect(isAuditType("agent.delta")).toBe(false);
  });
  test("redaction: built-in key shapes + configured patterns, deep, untouched when clean", () => {
    const res = compileRedactions(["secret-\\w+", "("]); // the bad pattern is skipped
    const v = {
      cmd: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' x",
      nested: ["ok", "secret-one"],
      n: 1,
    };
    const r = redactValue(v, res);
    expect(r.cmd).toBe("curl -H 'Authorization: [redacted]' x");
    expect(r.nested).toEqual(["ok", "[redacted]"]);
    expect(redactValue("sk-ant-api03-abcdefghijklmnopqrstuvwx", res)).toBe("[redacted]");
    const clean = { a: "fine", b: ["x"] };
    expect(redactValue(clean, res)).toBe(clean); // same reference: no allocation when nothing matched
  });
  test("rows + formats", () => {
    const rows = [
      auditRow({
        seq: 7,
        ts: "t",
        type: "claim.acquired",
        projectId: "p",
        sessionId: null,
        actor: { kind: "human", id: "alice" },
        payload: { task: "T1", owner: "alice", summary: 'claim "T1", by alice' },
      }),
    ];
    expect(rows[0]).toMatchObject({
      seq: 7,
      actorKind: "human",
      actorId: "alice",
      summary: 'claim "T1", by alice',
    });
    expect(formatAudit(rows, "jsonl").trim().split("\n")).toHaveLength(1);
    const csv = formatAudit(rows, "csv").split("\n");
    expect(csv[0]).toBe("seq,ts,type,projectId,sessionId,actorKind,actorId,summary,payload");
    expect(csv[1]).toContain('"claim ""T1"", by alice"');
    expect(JSON.parse(formatAudit(rows, "json"))).toHaveLength(1);
  });
  test("since parsing", () => {
    const now = Date.parse("2026-08-23T12:00:00Z");
    expect(sinceToIso("30d", now)).toBe("2026-07-24T12:00:00.000Z");
    expect(sinceToIso("12h", now)).toBe("2026-08-23T00:00:00.000Z");
    expect(sinceToIso("2026-08-01", now)).toBe("2026-08-01T00:00:00.000Z");
    expect(sinceToIso("yesterday", now)).toBeNull();
    expect(sinceToIso(null)).toBeNull();
  });
});
