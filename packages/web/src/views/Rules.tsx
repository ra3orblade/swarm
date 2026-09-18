/**
 * Rule effectiveness (M11.10): is a rule teaching anyone anything?
 *
 * A rule that fires once and never again taught somebody something. A rule that fires forty times
 * on the same shaped command is friction — either the habit needs changing or the rule does. That
 * is why the headline number is "not settling" rather than a raw incident count.
 */
import type { AgentCoverage } from "@swarm/core/agenthooks";
import type { RuleEffectReport, RuleStat } from "@swarm/core/ruleeffect";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { Columns, Panel, Stack } from "../components/Panel";
import { Sparkline } from "../components/Sparkline";
import { Badge, Empty, Failed, Loading, Section, Stat, StatRow } from "../components/ui";
import { ago } from "../lib/format";
import { useUiStore } from "../state/ui";

const TREND: Readonly<Record<RuleStat["trend"], [string, string]>> = {
  rising: ["bad", "rising"],
  falling: ["ok", "falling"],
  steady: ["", "steady"],
};

function RuleCard({ rule }: { rule: RuleStat }) {
  const [tone, word] = TREND[rule.trend];
  const worst = rule.clusters[0];

  return (
    <Panel
      title={rule.rule}
      hint={
        <>
          <b className={tone}>{word}</b> · {rule.total} incident{rule.total === 1 ? "" : "s"} ·{" "}
          {rule.acked} acked
        </>
      }
    >
      <div className="rule-spark">
        <Sparkline points={rule.perDay.map((d) => d.n)} />
        <span className="dim">{ago(rule.lastAt)} since the last one</span>
      </div>

      {worst && rule.total > 1 ? (
        <>
          <p className="rule-shape">
            {Math.round(rule.concentration * 100)}% of these are the same shape:{" "}
            <code>{worst.signature}</code>
          </p>
          <ul className="clusters">
            {rule.clusters.map((c) => (
              <li key={c.signature}>
                <b title={c.signature}>{c.signature}</b>
                <span className="n">{c.hits}×</span>
                <span title={c.example}>{c.example}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="dim rule-shape">Fired once. Whatever it was, it has not come back.</p>
      )}

      {rule.landed && (
        <p className="dim note">
          Since it landed {ago(rule.landed.at)} ago: <b>{rule.landed.afterPerDay.toFixed(1)}/day</b>
          , against {rule.landed.beforePerDay.toFixed(1)}/day before.
        </p>
      )}
    </Panel>
  );
}

/** M12.4: the same rules, on every agent whose hook Swarm is in. */
function WhereRulesHold() {
  const { data } = useResource<AgentCoverage[]>(routes.ruleAgents());
  if (!data) return null;
  return (
    <Panel title="Where the rules hold" hint="each agent's own pre-tool hook">
      <table className="mini">
        <colgroup>
          <col style={{ width: "18%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "30%" }} />
          <col style={{ width: "38%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>agent</th>
            <th>hook</th>
            <th>sees</th>
            <th>note</th>
          </tr>
        </thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.agent}>
              <td>
                <b>{a.label}</b>
              </td>
              <td>
                {a.present ? (
                  a.installed ? (
                    <Badge tone="ok">on</Badge>
                  ) : (
                    <Badge tone="warn">swarm install</Badge>
                  )
                ) : (
                  <span className="dim">not here</span>
                )}
              </td>
              <td className="clip" title={a.covers}>
                {a.covers}
              </td>
              <td className="clip dim" title={a.note ?? ""}>
                {a.note ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export function Rules() {
  const project = useUiStore((s) => s.project);
  const { data, error, reload } = useResource<RuleEffectReport>(routes.ruleEffect(project));

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (data.rules.length === 0) {
    return (
      <Stack>
        <Section title="Rules" hint="is a rule teaching anyone anything?">
          <Empty>
            No rule has fired{project ? " in this project" : ""} in the last 30 days.
            <br />
            That is the good outcome: rules exist to be learned and then never hit again.
          </Empty>
        </Section>
        <WhereRulesHold />
      </Stack>
    );
  }

  const t = data.totals;

  return (
    <>
      <Section
        title="Rules"
        hint={`${t.incidents} incidents · ${t.rules} rule${t.rules === 1 ? "" : "s"} · last 30 days`}
      />
      <StatRow>
        <Stat label="Incidents" value={t.incidents} detail="last 30 days" />
        <Stat
          label="Rules firing"
          value={t.rules}
          detail={`${t.acked} incident${t.acked === 1 ? "" : "s"} acknowledged`}
        />
        <Stat
          label="Not settling"
          value={t.unchanged}
          detail={t.unchanged ? "firing as much as ever, or more" : "every rule is quieting down"}
          tone={t.unchanged ? "hot" : undefined}
        />
        <Stat
          label="Change history"
          value={data.noChangeHistory ? "none" : "yes"}
          detail={data.noChangeHistory ? "no before/after yet" : "before/after available"}
        />
      </StatRow>

      <Stack>
        <Columns>
          {data.rules.map((rule) => (
            <RuleCard key={rule.rule} rule={rule} />
          ))}
        </Columns>
        <WhereRulesHold />
      </Stack>

      {data.noChangeHistory && (
        <p className="dim note">
          <b>No before-and-after yet.</b> Comparing a rule's rate before and after it landed needs
          to know when it landed, and nothing recorded that until now — the daemon writes{" "}
          <code>rules.changed</code> from this version on, so the comparison fills in for edits made
          from here.
        </p>
      )}
    </>
  );
}
