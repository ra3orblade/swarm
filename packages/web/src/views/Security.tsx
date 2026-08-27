/**
 * Security (M11.10): what agents reached for.
 *
 * This is a lint, not a sandbox. Everything is matched against recorded command *text*, so an
 * obfuscated command will not match and a comment mentioning `.env` will. It over-reports on
 * purpose: a host listed here was named by an agent, which is not the same as bytes having left.
 */
import type { SecurityReport } from "@swarm/core/security";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { Columns, Panel, Stack } from "../components/Panel";
import { Badge, Empty, Failed, Loading, Section, Stat, StatRow } from "../components/ui";
import { useUiStore } from "../state/ui";

export function Security() {
  const project = useUiStore((s) => s.project);
  const { data, error, reload } = useResource<SecurityReport>(routes.security(project));

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const t = data.totals;
  if (!t.scanned) {
    return (
      <Section title="Security" hint="what agents reached for">
        <Empty>No commands recorded{project ? " in this project" : ""} in the last 14 days.</Empty>
      </Section>
    );
  }

  const remote = data.egress.filter((h) => !h.local);
  const ecosystems = new Set(data.installs.map((i) => i.ecosystem)).size;

  return (
    <>
      <Section title="Security" hint={`${t.scanned.toLocaleString()} commands · last 14 days`} />
      <StatRow>
        <Stat
          label="Hosts reached"
          value={t.remoteHosts}
          detail={`${data.egress.length - t.remoteHosts} more were local`}
        />
        <Stat
          label="Packages installed"
          value={t.installs}
          detail={`${ecosystems} ecosystem${ecosystems === 1 ? "" : "s"}`}
        />
        <Stat
          label="Credential files opened"
          value={t.secrets}
          detail={t.secrets ? "by name — contents are never read" : "none"}
          tone={t.secrets ? "hot" : undefined}
        />
        <Stat label="Commands scanned" value={t.scanned.toLocaleString()} detail="last 14 days" />
      </StatRow>

      <Columns>
        <Panel title="Hosts reached" hint="named in a command or a fetch">
          {remote.length > 0 ? (
            <table className="mini">
              <colgroup>
                <col style={{ width: "60%" }} />
                <col style={{ width: "20%" }} />
                <col style={{ width: "20%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>host</th>
                  <th className="num">times</th>
                  <th className="num">sessions</th>
                </tr>
              </thead>
              <tbody>
                {remote.slice(0, 14).map((h) => (
                  <tr key={h.host}>
                    <td className="clip path">
                      <b>{h.host}</b>
                    </td>
                    <td className="num">{h.hits}</td>
                    <td className="num">{h.sessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dim">Nothing but localhost.</div>
          )}
          <p className="dim note">
            A host here means an agent <em>named</em> it. Whether bytes left is not something Swarm
            can see without running the command, so it over-reports rather than under-reports.
          </p>
        </Panel>

        <Stack>
          <Panel title="Credential files" hint="opened by name">
            {data.secrets.length > 0 ? (
              <>
                <ul className="plainlist">
                  {data.secrets.map((s) => (
                    <li key={s.what}>
                      <Badge tone="warn">{s.what}</Badge>
                      <b>{s.hits}×</b>
                      <span className="dim">
                        {s.sessions} session{s.sessions === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="dim note">
                  Swarm reads the <em>path</em>, never the contents — this says something opened the
                  file and nothing about what was in it.
                </p>
              </>
            ) : (
              <div className="dim">No credential file was opened by name.</div>
            )}
          </Panel>

          <Panel title="Packages installed" hint="what the machine will run later">
            {data.installs.length > 0 ? (
              <ul className="plainlist">
                {data.installs.slice(0, 12).map((i) => (
                  <li key={`${i.ecosystem}:${i.pkg}`}>
                    <Badge>{i.ecosystem}</Badge>
                    <b>{i.pkg}</b>
                    <span className="dim">{i.hits}×</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="dim">Nothing was installed.</div>
            )}
          </Panel>
        </Stack>
      </Columns>

      <p className="dim note">
        <b>This is a lint, not a sandbox.</b> Everything here is matched against the recorded
        command text, so an obfuscated command will not match and a comment mentioning{" "}
        <code>.env</code> will. It is here to tell you what your fleet does, so you can decide what
        to write an <code>ask</code> rule about.
      </p>
    </>
  );
}
