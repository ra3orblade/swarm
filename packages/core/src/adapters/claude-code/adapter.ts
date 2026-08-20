import type { AgentAdapter, LogParseResult } from "../types";
import { parseTranscriptChunk } from "./transcript";

/** Claude Code also has live hooks (handled separately by the daemon); the shared surface is the
 *  transcript JSONL parsed here. */
export const claudeCodeAdapter: AgentAdapter = {
  id: "claude-code",
  label: "Claude Code",
  parseLog(chunk: string): LogParseResult {
    const d = parseTranscriptChunk(chunk);
    return { turns: d.turns, title: d.title, version: d.version };
  },
};
