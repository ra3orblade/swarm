import { describe, expect, it } from "bun:test";
import { isOurs, pickPort } from "./processes";

describe("process registry", () => {
  it("pickPort skips ledger-taken and bind-refused ports", () => {
    const free = (p: number) => p !== 3401;
    expect(pickPort(3400, [3400], free)).toBe(3402);
    expect(pickPort(3400, [], free)).toBe(3400);
    expect(pickPort(65535, [65535], free)).toBeNull();
    expect(pickPort(3400, [], () => false, 3)).toBeNull();
  });
  it("isOurs needs a live pid with the same start time", () => {
    const row = { pid: 10, startTime: "Mon Aug 22 10:00:00 2026" };
    expect(isOurs(row, true, "Mon Aug 22 10:00:00 2026")).toBe(true);
    expect(isOurs(row, true, "Tue Aug 23 10:00:00 2026")).toBe(false); // recycled pid
    expect(isOurs(row, false, "Mon Aug 22 10:00:00 2026")).toBe(false);
    expect(isOurs({ pid: 10, startTime: null }, true, "x")).toBe(true);
  });
});
