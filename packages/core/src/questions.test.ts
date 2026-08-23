import { describe, expect, test } from "bun:test";
import { formatAnswers, formatOpenQuestions, type Question, validateQuestion } from "./questions";

const q = (o: Partial<Question>): Question => ({
  id: 1,
  projectId: "p",
  sessionId: "s",
  task: null,
  text: "Which DB?",
  options: [],
  askedBy: null,
  createdAt: "t",
  answer: null,
  answeredBy: null,
  answeredAt: null,
  deliveredAt: null,
  ...o,
});

describe("questions", () => {
  test("validateQuestion trims, caps options at 8, rejects empties", () => {
    expect(
      validateQuestion("  Which database should I use?  ", [
        "a",
        " b ",
        "",
        3,
        ...Array(10).fill("x"),
      ]),
    ).toEqual({
      ok: true,
      text: "Which database should I use?",
      options: ["a", "b", "x", "x", "x", "x", "x", "x"],
    });
    expect(validateQuestion("hi", []).ok).toBe(false);
    expect(validateQuestion(42, []).ok).toBe(false);
  });
  test("formatAnswers / formatOpenQuestions", () => {
    expect(formatAnswers([q({})])).toBeNull();
    expect(formatAnswers([q({ answer: "Postgres", answeredBy: "andrew" })])).toBe(
      '[swarm] answer from andrew to your question "Which DB?": Postgres',
    );
    expect(formatOpenQuestions([q({ answer: "x" })])).toBeNull();
    expect(formatOpenQuestions([q({ id: 7 })])).toContain('#7 "Which DB?"');
  });
});
