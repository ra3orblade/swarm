/**
 * Waiting on you (M9.4, M12.11): how long sessions sat blocked on a person, beside the waits that
 * ended without one. A background task finishing, a subagent's report or a message from another
 * session also wakes an idle session; those are counted on their own, so "answered" means you.
 */
import { routes } from "../../api/endpoints";
import { useResource } from "../../api/useResource";
import { Section, Stat, StatRow } from "../../components/ui";
import { duration } from "../../lib/format";

/** The daemon keeps waits for at most 90 days. */
const MAX_DAYS = 90;

export function WaitingStrip({ project, days }: { project: string | null; days: number }) {
  const span = Math.min(days, MAX_DAYS);
  const { data } = useResource(routes.waiting(project, span), 120_000);
  if (!data || (!data.totals.episodes && !data.totals.woken.episodes)) return null;
  const t = data.totals;
  const w = t.woken;
  const by = [
    w.byOrigin.task && `${w.byOrigin.task} by a task`,
    w.byOrigin.agent && `${w.byOrigin.agent} by a report`,
    w.byOrigin.session && `${w.byOrigin.session} by a message`,
  ].filter(Boolean);
  return (
    <>
      <Section title="Waiting on you" hint={`last ${span} days`} />
      <StatRow>
        <Stat
          label="waits you answered"
          value={t.episodes}
          detail={`median ${duration(t.medianMs)} · longest ${duration(t.longestMs)}`}
        />
        <Stat
          label="blocked on you"
          value={duration(t.blockedMs)}
          detail={t.waitingNow ? `${t.waitingNow} waiting now` : "nobody waiting now"}
        />
        <Stat
          label="woken without you"
          value={w.episodes}
          detail={by.length ? by.join(" · ") : "every wait ended with you"}
        />
        <Stat
          label="idle before a wake"
          value={duration(w.ms)}
          detail="not counted as blocked on you"
        />
      </StatRow>
    </>
  );
}
