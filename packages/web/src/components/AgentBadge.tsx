/** An agent's name in its fixed categorical colour (M11.5). */
import { agentColor, agentName } from "../lib/agents";

export function AgentBadge({ agent }: { agent: string }) {
  if (!agent) return null;
  const color = agentColor(agent);
  return (
    <span
      className="badge agent"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {agentName(agent)}
    </span>
  );
}
