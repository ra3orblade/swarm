/**
 * Context (M11.9): where the window goes, and what re-reading costs.
 *
 * Character counts are exact — every tool response is stored. Token figures are a flat 4:1
 * estimate and say so. MCP tool schemas and the system prompt are *not* included: Swarm sees tool
 * calls, never the schemas or the prompt preamble, so they are left out rather than guessed at.
 */
import type { ContextReport } from "@swarm/core/context";
import type { SessionView } from "@swarm/core/types";
import { useMemo } from "react";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { BarList } from "../components/BarList";
import { Columns, Panel } from "../components/Panel";
import { Empty, Failed, Loading, Section, Stat, StatRow } from "../components/ui";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";

/** Exact character counts, abbreviated for a cell. */
function chars(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/**
 * An MCP tool id puts the server first, so four `claude-in-chrome` tools all truncated to
 * "claude-in-c…" and the half that told them apart was the half cut off. Lead with the tool.
 */
export function toolLabel(tool: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  if (!m) return tool;
  const server = (m[1] ?? "")
    .replace(/[-_]/g, " ")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toLowerCase();
  return `${m[2]} · ${server}`;
}

export function Context() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const { data, error, reload } = useResource<ContextReport>(routes.context(project));
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY);
  // The report carries only ids. The vanilla view read `s.title` off it, which never existed, so
  // every row silently showed a truncated id; joining to the snapshot gives the real title back.
  const titleOf = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s.title]));
    return (id: string) => byId.get(id) ?? null;
  }, [sessions]);

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const t = data.totals;
  if (!t.sessions) {
    return (
      <Section title="Context" hint="where the window goes">
        <Empty>No tool results in the last 7 days{project ? " in this project" : ""}.</Empty>
      </Section>
    );
  }

  const worst = data.sessions.filter((s) => s.wastedChars > 0).slice(0, 10);

  return (
    <>
      <Section
        title="Context"
        hint={`last 7 days · ${chars(t.toolChars)} characters returned by tools`}
      />
      <StatRow>
        <Stat
          label="Returned by tools"
          value={chars(t.toolChars)}
          detail={`characters · ≈${chars(t.toolTokens)} tokens`}
        />
        <Stat
          label="Spent re-reading"
          value={chars(t.wastedChars)}
          detail={
            t.wasteShare
              ? `${Math.round(t.wasteShare * 100)}% of it · ${t.rereadFiles} file${t.rereadFiles === 1 ? "" : "s"}`
              : "nothing re-read"
          }
          tone={t.wasteShare > 0.1 ? "hot" : t.wasteShare > 0.03 ? "warm" : undefined}
        />
        <Stat
          label="Cache hit"
          value={`${Math.round(t.cacheHit * 100)}%`}
          detail="of the window came back free"
        />
        <Stat label="Sessions" value={t.sessions} detail="with tool activity" />
      </StatRow>

      <Columns>
        <Panel title="What fills the window" hint="by tool · characters returned">
          <BarList
            bars={data.byTool.map((x) => ({
              label: toolLabel(x.tool),
              value: x.chars,
              detail: `${chars(x.chars)} · ${x.calls}`,
            }))}
          />
        </Panel>

        <Panel title="Re-read waste" hint="the same file, read again">
          {worst.length > 0 ? (
            <table className="mini">
              <colgroup>
                <col style={{ width: "31%" }} />
                <col style={{ width: "15%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "11%" }} />
                <col style={{ width: "29%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>session</th>
                  <th className="num">returned</th>
                  <th className="num">wasted</th>
                  <th className="num">share</th>
                  <th>worst files</th>
                </tr>
              </thead>
              <tbody>
                {worst.map((s) => (
                  <tr
                    key={s.sessionId}
                    onClick={() => openSession(s.sessionId)}
                    className="clickable"
                  >
                    <td>{titleOf(s.sessionId) ?? s.sessionId.slice(0, 8)}</td>
                    <td className="num">{chars(s.toolChars)}</td>
                    <td className="num">
                      <b>{chars(s.wastedChars)}</b>
                    </td>
                    <td className="num">{Math.round(s.wasteShare * 100)}%</td>
                    <td className="clip">
                      {s.worst.slice(0, 2).map((w) => (
                        <span
                          key={w.path}
                          className="br"
                          title={`${w.path} — read ${w.reads}× · ${chars(w.wastedChars)} chars re-read`}
                        >
                          {w.path.split("/").at(-1)} <b>{w.reads}×</b>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dim">Nothing was read twice — no waste to report.</div>
          )}
        </Panel>
      </Columns>

      <p className="dim note">
        Character counts are exact — every tool response is stored. Token figures are a flat 4:1
        estimate. <b>MCP tool schemas and the system prompt are not included</b>: Swarm sees tool
        calls, never the schemas or the prompt preamble, so they are left out rather than guessed
        at.
      </p>
    </>
  );
}

const EMPTY: SessionView[] = [];
