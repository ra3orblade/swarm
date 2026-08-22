import { describe, expect, it } from "bun:test";
import { canAcquire, isAliveHolding, isTrackedPid, type Resource } from "./resources";

const base: Resource = {
  name: "dev-server",
  kind: "process",
  projectId: "p1",
  owner: "agent-a",
  sessionId: "s1",
  pid: null,
  port: 3000,
  acquiredAt: new Date().toISOString(),
  expiresAt: null,
  released: false,
};
const now = Date.now();

describe("resources", () => {
  it("pid-tracked holding is alive only while the pid runs", () => {
    const r = { ...base, pid: 123 };
    expect(isAliveHolding(r, now, () => true)).toBe(true);
    expect(isAliveHolding(r, now, () => false)).toBe(false);
  });

  it("lease-tracked holding expires", () => {
    const live = { ...base, expiresAt: new Date(now + 60_000).toISOString() };
    const dead = { ...base, expiresAt: new Date(now - 1).toISOString() };
    expect(isAliveHolding(live, now, () => false)).toBe(true);
    expect(isAliveHolding(dead, now, () => false)).toBe(false);
  });

  it("acquire fails closed while held by another owner", () => {
    const d = canAcquire({ ...base, pid: 1 }, { owner: "agent-b" }, now, () => true);
    expect(d.ok).toBe(false);
  });

  it("same owner re-acquires; dead holder does not block", () => {
    expect(canAcquire({ ...base, pid: 1 }, { owner: "agent-a" }, now, () => true).ok).toBe(true);
    expect(canAcquire({ ...base, pid: 1 }, { owner: "agent-b" }, now, () => false).ok).toBe(true);
  });

  it("released holding never blocks", () => {
    expect(canAcquire({ ...base, released: true }, { owner: "agent-b" }, now, () => true).ok).toBe(
      true,
    );
  });

  it("lease-tracked holding fails closed for another owner", () => {
    const live = { ...base, pid: null, expiresAt: new Date(now + 60_000).toISOString() };
    const d = canAcquire(live, { owner: "agent-b" }, now, () => false);
    expect(d.ok).toBe(false);
    expect(canAcquire(live, { owner: "agent-a" }, now, () => false).ok).toBe(true);
  });

  it("pid 0 is not a tracked process (kill(0) is the process group)", () => {
    expect(isTrackedPid(0)).toBe(false);
    expect(isTrackedPid(-1)).toBe(false);
    expect(isTrackedPid(1)).toBe(true);
    const leased = { ...base, pid: 0, expiresAt: new Date(now + 60_000).toISOString() };
    expect(isAliveHolding(leased, now, () => true)).toBe(true);
    const expired = { ...base, pid: 0, expiresAt: new Date(now - 1).toISOString() };
    expect(isAliveHolding(expired, now, () => true)).toBe(false);
  });
});
