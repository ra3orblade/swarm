import { aiderAdapter } from "./aider/history";
import { claudeCodeAdapter } from "./claude-code/adapter";
import { codexAdapter } from "./codex/rollout";
import { geminiAdapter } from "./gemini/chats";
import { grokAdapter } from "./grok/updates";
import { opencodeAdapter } from "./opencode/db";
import type { AgentAdapter } from "./types";

export type { AiderCarry, AiderSegment } from "./aider/history";
export { aiderAdapter, parseAiderHistory, parseAiderLog } from "./aider/history";
export { claudeCodeAdapter } from "./claude-code/adapter";
export { codexAdapter, parseCodexRollout } from "./codex/rollout";
export { geminiAdapter, parseGeminiChat } from "./gemini/chats";
export { grokAdapter, parseGrokUpdates } from "./grok/updates";
export { opencodeAdapter, opencodeTurn, parseOpencodeLog } from "./opencode/db";
export * from "./types";

/** All agents Swarm can observe. */
export const ADAPTERS: AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  grokAdapter,
  geminiAdapter,
  aiderAdapter,
  opencodeAdapter,
];

export function adapterById(id: string): AgentAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
