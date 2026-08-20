import { claudeCodeAdapter } from "./claude-code/adapter";
import { codexAdapter } from "./codex/rollout";
import { grokAdapter } from "./grok/updates";
import type { AgentAdapter } from "./types";

export { claudeCodeAdapter } from "./claude-code/adapter";
export { codexAdapter, parseCodexRollout } from "./codex/rollout";
export { grokAdapter, parseGrokUpdates } from "./grok/updates";
export * from "./types";

/** All agents Swarm can observe. */
export const ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, grokAdapter];

export function adapterById(id: string): AgentAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
