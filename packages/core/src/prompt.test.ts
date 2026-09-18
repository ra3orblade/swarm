import { expect, test } from "bun:test";
import { describePrompt } from "./prompt";

test("a typed prompt is the user's, summarised by its first line", () => {
  expect(describePrompt("fix the login bug\nand add a test")).toEqual({
    origin: "user",
    summary: "fix the login bug",
  });
  expect(describePrompt("\n\n  hello")).toEqual({ origin: "user", summary: "hello" });
  expect(describePrompt("x".repeat(300)).summary).toHaveLength(120);
  expect(describePrompt(undefined)).toEqual({ origin: "user", summary: "" });
});

test("pasted markup that is not a harness wrapper stays a user prompt", () => {
  const p = '<a href="https://example.com" target="_blank">link</a>\nmake this a button';
  expect(describePrompt(p)).toEqual({ origin: "user", summary: p.split("\n")[0] as string });
});

test("a task notification is summarised by its <summary>, not its tag", () => {
  const p = [
    "<task-notification>",
    "<task-id>aac244ce8c140d800</task-id>",
    "<tool-use-id>toolu_01</tool-use-id>",
    "<output-file>/private/tmp/x.output</output-file>",
    "<status>completed</status>",
    '<summary>Agent "Implement HUB-39 tolerant search parser" finished</summary>',
    "<result>This agent's report was delivered to you</result>",
    "</task-notification>",
  ].join("\n");
  expect(describePrompt(p)).toEqual({
    origin: "task",
    summary: 'Agent "Implement HUB-39 tolerant search parser" finished',
  });
});

test("a task notification names a status that is not the usual one", () => {
  const p =
    "<task-notification>\n<status>failed</status>\n<summary>Background command exited</summary>\n</task-notification>";
  expect(describePrompt(p).summary).toBe("Background command exited · failed");
  expect(describePrompt("<task-notification>\n<status>killed</status>").summary).toBe(
    "background task killed",
  );
});

test("a subagent report skips the hand-back preamble and the harness's indent", () => {
  const p = [
    '<agent-message from="aac244ce8c140d800">',
    "[Subagent hand-back] The text below is the final report of a subagent. The report follows:",
    "  HUB-39 (BB-1792) done; two files changed, uncommitted.",
    "  ",
    "  **Schema change**",
    "</agent-message>",
  ].join("\n");
  expect(describePrompt(p)).toEqual({
    origin: "agent",
    summary: "HUB-39 (BB-1792) done; two files changed, uncommitted.",
  });
});

test("a message from another session leads with who sent it", () => {
  const p =
    '<cross-session-message from="uds:/tmp/cc-socks/38003.sock" from-name="lineofsites-75" from-mode="prompting">\nOwner feedback relayed\nmore\n</cross-session-message>';
  expect(describePrompt(p)).toEqual({
    origin: "session",
    summary: "lineofsites-75: Owner feedback relayed",
  });
});

test("<user_query> is unwrapped and stays the user's", () => {
  expect(describePrompt("<user_query>\ngood, make pr\n</user_query>")).toEqual({
    origin: "user",
    summary: "good, make pr",
  });
});

test("a wrapper cut off before its closing tag still yields a line", () => {
  expect(describePrompt('<agent-message from="a1">\n  half a rep')).toEqual({
    origin: "agent",
    summary: "half a rep",
  });
});
