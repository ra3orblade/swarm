import { describe, expect, it } from "vitest";
import { projectIdentity } from "./project-id";

describe("projectIdentity", () => {
  it("maps every worktree of a repo to the same id via the common dir", () => {
    const common = "/Users/me/repo/.git";
    const a = projectIdentity({ root: "/Users/me/repo", commonDir: common });
    const b = projectIdentity({ root: "/Users/me/.harness/wt/repo/m0.6", commonDir: common });
    expect(a.id).toBe(b.id);
  });

  it("uses the folder path for non-git folders", () => {
    const a = projectIdentity({ root: "/tmp/x", commonDir: null });
    const b = projectIdentity({ root: "/tmp/y", commonDir: null });
    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe("x");
  });
});
