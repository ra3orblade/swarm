import { describe, expect, test } from "bun:test";
import { squashed } from "./git";

describe("squashed", () => {
  test("every commit already upstream by patch id is a squash merge", () => {
    // `merge-base --is-ancestor` says no for these forever, because a squash rewrote them.
    expect(squashed("- abc123 first\n- def456 second")).toBe(true);
  });

  test("one commit not upstream means the branch still has work", () => {
    expect(squashed("- abc123 landed\n+ def456 not yet")).toBe(false);
  });

  test("a branch with nothing ahead of base is not called merged", () => {
    // is-ancestor already covers that case; an empty cherry must not be read as a merge.
    expect(squashed("")).toBe(false);
    expect(squashed("   \n  ")).toBe(false);
  });

  test("no output at all (git failed) is not a merge", () => {
    expect(squashed(null)).toBe(false);
  });
});
