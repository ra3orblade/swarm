import { describe, expect, it } from "bun:test";
import { hasOwnSummary, summarizeToolInput } from "./adapters/claude-code/hooks";
import { askedQuestions, permissionHookOutput, questionAnswers } from "./permissions";

const INPUT = {
  questions: [
    {
      question: "Which framework?",
      header: "Framework",
      multiSelect: false,
      options: [{ label: "React", description: "what the dashboard uses" }, { label: "Vue" }],
    },
    { question: "Which checks?", header: "Checks", multiSelect: true, options: ["lint", "test"] },
  ],
};

describe("askedQuestions", () => {
  it("reads questions, options and the multi-select flag", () => {
    const qs = askedQuestions(INPUT);
    expect(qs.map((q) => q.question)).toEqual(["Which framework?", "Which checks?"]);
    expect(qs[0]?.options[0]).toEqual({ label: "React", description: "what the dashboard uses" });
    expect(qs[0]?.options[1]).toEqual({ label: "Vue", description: "" });
    expect(qs[1]?.multiSelect).toBe(true);
    expect(qs[1]?.options.map((o) => o.label)).toEqual(["lint", "test"]);
  });
  it("parses questions that arrived as a JSON string", () => {
    expect(askedQuestions({ questions: JSON.stringify(INPUT.questions) })).toHaveLength(2);
  });
  it("returns nothing for input it cannot draw", () => {
    expect(askedQuestions(null)).toEqual([]);
    expect(askedQuestions({ questions: "not json" })).toEqual([]);
    expect(askedQuestions({ questions: [{ header: "no text" }, null] })).toEqual([]);
  });
});

describe("questionAnswers", () => {
  it("joins multi-select labels with commas and drops unanswered questions", () => {
    expect(questionAnswers({ a: ["x", " y "], b: [""], c: [] })).toEqual({ a: "x, y" });
  });
});

describe("permissionHookOutput", () => {
  it("echoes the input back with answers on allow", () => {
    const out = permissionHookOutput(
      { behavior: "allow", by: "dashboard", answers: { "Which framework?": "React" } },
      INPUT,
    );
    expect(out.hookSpecificOutput?.decision.updatedInput).toEqual({
      ...INPUT,
      answers: { "Which framework?": "React" },
    });
  });
  it("leaves the input untouched without answers, and says nothing for the terminal", () => {
    const out = permissionHookOutput({ behavior: "allow", by: "dashboard" }, INPUT);
    expect(out.hookSpecificOutput?.decision.updatedInput).toBe(INPUT);
    expect(permissionHookOutput({ behavior: null, by: "terminal" }, INPUT)).toEqual({});
  });
});

describe("summarizeToolInput for AskUserQuestion", () => {
  it("is the question, not truncated JSON", () => {
    expect(summarizeToolInput("AskUserQuestion", INPUT)).toBe("Which framework? (+1 more)");
    expect(hasOwnSummary("AskUserQuestion")).toBe(true);
    expect(hasOwnSummary("mcp__linear__save_issue")).toBe(false);
  });
});
