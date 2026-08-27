/**
 * Files (M11.9): file-touch heat, and what is worth writing down.
 *
 * "Worth writing down" is the useful column: several sessions keep reading a file and rarely change
 * it, which means the same conclusion is being re-derived every time. That belongs in `CLAUDE.md`
 * once instead.
 */
import type { HeatReport } from "@swarm/core/heat";
import { useMemo } from "react";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { Columns, Panel, Stack } from "../components/Panel";
import { PathCell } from "../components/PathCell";
import { Empty, Failed, Loading, Section, Stat, StatRow } from "../components/ui";
import { shortPath } from "../lib/format";
import { disambiguate } from "../lib/paths";
import { useUiStore } from "../state/ui";

export function Files() {
  const project = useUiStore((s) => s.project);
  const { data, error, reload } = useResource<HeatReport>(routes.heat(project));

  const files = useMemo(() => data?.files.slice(0, 14) ?? [], [data]);
  const dirs = useMemo(() => data?.dirs.slice(0, 10) ?? [], [data]);
  const candidates = useMemo(() => data?.candidates.slice(0, 10) ?? [], [data]);
  const fileHints = useMemo(() => disambiguate(files.map((f) => f.path)), [files]);
  const dirHints = useMemo(() => disambiguate(dirs.map((d) => d.dir)), [dirs]);
  const candHints = useMemo(() => disambiguate(candidates.map((f) => f.path)), [candidates]);

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (data.files.length === 0) {
    return (
      <Section title="Files" hint="file-touch heat">
        <Empty>
          No file was touched more than once{project ? " in this project" : ""} in the last 14 days.
        </Empty>
      </Section>
    );
  }

  const t = data.totals;
  const busiest = dirs[0]?.touches || 1;

  return (
    <>
      <Section
        title="Files"
        hint={`${t.files.toLocaleString()} files · ${t.touches.toLocaleString()} touches · ${t.sessions} sessions · last 14 days`}
      />
      <StatRow>
        <Stat
          label="Files touched"
          value={t.files.toLocaleString()}
          detail={`${t.touches.toLocaleString()} touches · last 14 days`}
        />
        <Stat
          label="Re-reads"
          value={t.rereads.toLocaleString()}
          detail={
            t.touches ? `${Math.round((t.rereads / t.touches) * 100)}% of every touch` : "none"
          }
        />
        <Stat
          label="Touched once"
          value={t.cold.toLocaleString()}
          detail="cold — read and never returned to"
        />
        <Stat
          label="CLAUDE.md candidates"
          value={data.candidates.length}
          detail={
            data.candidates.length ? "re-read by several sessions" : "nothing worth writing down"
          }
          tone={data.candidates.length ? "warm" : undefined}
        />
      </StatRow>

      <Columns>
        <Panel title="Hottest files" hint="every touch, across sessions">
          <table className="mini">
            <colgroup>
              <col style={{ width: "46%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "13%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>path</th>
                <th className="num">touches</th>
                <th className="num">sessions</th>
                <th className="num">re-reads</th>
                <th className="num">writes</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.path}>
                  <td className="clip path" title={shortPath(f.path)}>
                    <PathCell path={f.path} hint={fileHints.get(f.path)} />
                  </td>
                  <td className="num">
                    <b>{f.touches.toLocaleString()}</b>
                  </td>
                  <td className="num">{f.sessions}</td>
                  <td className="num">{f.rereads.toLocaleString()}</td>
                  <td className="num">{f.writes.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Stack>
          <Panel title="Worth writing down" hint="read again and again, rarely written">
            {candidates.length > 0 ? (
              <>
                <table className="mini">
                  <colgroup>
                    <col style={{ width: "58%" }} />
                    <col style={{ width: "22%" }} />
                    <col style={{ width: "20%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>path</th>
                      <th className="num">re-reads</th>
                      <th className="num">sessions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((f) => (
                      <tr key={f.path}>
                        <td className="clip path" title={shortPath(f.path)}>
                          <PathCell path={f.path} hint={candHints.get(f.path)} />
                        </td>
                        <td className="num">
                          <b>{f.rereads.toLocaleString()}</b>
                        </td>
                        <td className="num">{f.sessions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="dim note">
                  Several sessions keep reading these and rarely change them — the conclusion is
                  being re-derived every time. Put it in <code>CLAUDE.md</code> once instead.
                </p>
              </>
            ) : (
              <div className="dim">
                Nothing here is worth extracting. Every file several sessions re-read is also one
                they edit — that is where the work is, not a reference being re-learned.
              </div>
            )}
          </Panel>

          <Panel title="By directory" hint="where the work sits">
            <ul className="heatlist">
              {dirs.map((d) => (
                <li key={d.dir}>
                  <span
                    className="bar"
                    style={
                      {
                        "--w": `${Math.max(2, Math.round((d.touches / busiest) * 100))}%`,
                      } as React.CSSProperties
                    }
                  />
                  <span className="clip path" title={shortPath(d.dir)}>
                    <PathCell path={d.dir} hint={dirHints.get(d.dir)} />
                  </span>
                  <b>{d.touches.toLocaleString()}</b>
                  <span className="dim">
                    {d.files} file{d.files === 1 ? "" : "s"} · {d.sessions} session
                    {d.sessions === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </Stack>
      </Columns>

      <p className="dim note">
        <b>Incidents are not correlated here.</b> An incident records the rule, the action and the
        command — not a path — so tying a rule that fired on a shell command to a file would mean
        parsing paths out of command strings and guessing.
      </p>
    </>
  );
}
