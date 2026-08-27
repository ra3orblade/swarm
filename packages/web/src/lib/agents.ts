/**
 * Agent identity: a fixed colour slot and a display name per agent (M11.5).
 *
 * The slot is deliberately fixed rather than cycled. An agent that changes colour when another one
 * appears in the fleet makes every chart lie about what you compared it against yesterday.
 */

const SLOT: Readonly<Record<string, number>> = {
  "claude-code": 1,
  codex: 2,
  gemini: 3,
  grok: 4,
  aider: 5,
  cline: 6,
  opencode: 7,
};

const NAME: Readonly<Record<string, string>> = {
  "claude-code": "Claude",
  codex: "Codex",
  gemini: "Gemini",
  grok: "Grok",
  aider: "Aider",
  cline: "Cline",
  opencode: "opencode",
};

/** A categorical design token, never a raw colour. */
export function agentColor(agent: string): string {
  return `var(--c${SLOT[agent] ?? 0})`;
}

export function agentName(agent: string): string {
  return NAME[agent] ?? agent;
}

/** Registry order, so legends and chips are stable across views. */
export const AGENT_ORDER: readonly string[] = Object.keys(SLOT);

export function agentSort(a: string, b: string): number {
  return (SLOT[a] ?? 99) - (SLOT[b] ?? 99);
}
