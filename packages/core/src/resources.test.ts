import { describe, expect, it } from "bun:test";
import { canAcquire, isAliveHolding, type Resource } from "./resources";

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
});
