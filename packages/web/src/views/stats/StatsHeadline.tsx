/**
 * The two headline strips on Stats (M11.9).
 *
 * The second one is deliberately unserious. Token counts in the billions stop meaning anything, so
 * the equivalents — novels written, War and Peace re-read, coffees — are there to give the numbers
 * a size a person can hold. The conversion is stated in the footnote rather than hidden.
 */

import { streaks } from "../../components/charts";
import { Stat, StatRow } from "../../components/ui";
import { big, share, tokens, usd } from "../../lib/format";
import type { StatsReport } from "./types";

/** A token is roughly 0.75 words; a novel roughly 90k words; War and Peace roughly 587k. */
const WORDS_PER_TOKEN = 0.75;
const WORDS_PER_NOVEL = 90_000;
const WORDS_IN_WAR_AND_PEACE = 587_000;
const DOLLARS_PER_COFFEE = 5;
/** A printed page is roughly 300 words — the fallback when the total is under one novel. */
const WORDS_PER_PAGE = 300;

export interface StatsHeadlineProps {
  report: StatsReport;
}

export function StatsHeadline({ report }: StatsHeadlineProps) {
  const totals = report.totals;
  const since = totals.firstTs ? new Date(totals.firstTs) : null;
  const spanDays = since ? Math.max(1, Math.round((Date.now() - since.getTime()) / 86_400_000)) : 1;
  const activeDays = report.daily.filter((d) => d.turns).map((d) => d.day);
  const streak = streaks(activeDays);

  const allTokens = totals.input + totals.cacheWrite + totals.cacheRead + totals.output;
  const words = totals.output * WORDS_PER_TOKEN;
  const novels = words / WORDS_PER_NOVEL;
  const contextWords = (totals.input + totals.cacheRead + totals.cacheWrite) * WORDS_PER_TOKEN;
  const warAndPeace = contextWords / WORDS_IN_WAR_AND_PEACE;
  const coffees = (totals.cost ?? 0) / DOLLARS_PER_COFFEE;

  return (
    <>
      <StatRow>
        <Stat
          label="all-time spend"
          value={usd(totals.cost) ?? "—"}
          detail={`since ${since ? since.toISOString().slice(0, 10) : "—"} · ${usd((totals.cost ?? 0) / spanDays)}/day`}
        />
        <Stat
          label="tokens processed"
          value={big(allTokens)}
          detail={`${big(totals.output)} out · ${big(totals.cacheRead)} cache read`}
        />
        <Stat
          label="turns"
          value={big(totals.turns)}
          detail={`${totals.sessions} sessions · ${big(totals.toolCalls)} tool calls`}
        />
        <Stat
          label="streak"
          value={`${streak.current}d`}
          detail={`longest ${streak.longest}d · ${activeDays.length} active day${activeDays.length === 1 ? "" : "s"} this year`}
        />
      </StatRow>

      <StatRow>
        <Stat
          label="words written"
          value={big(words)}
          detail={
            novels >= 1
              ? `≈ ${novels.toFixed(novels < 10 ? 1 : 0)} novels`
              : `≈ ${(words / WORDS_PER_PAGE).toFixed(0)} pages`
          }
        />
        <Stat
          label="context re-read"
          value={`${big(contextWords)} words`}
          detail={
            warAndPeace >= 1
              ? `≈ ${warAndPeace.toFixed(warAndPeace < 10 ? 1 : 0)}× War and Peace`
              : `≈ ${(contextWords / WORDS_PER_PAGE).toFixed(0)} pages`
          }
        />
        <Stat
          label="thinking share"
          value={share(totals.thinking, totals.output)}
          detail={`${tokens(totals.thinking)} reasoning tokens · cache hit ${share(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite)}`}
        />
        <Stat
          label="in coffee"
          value={`${coffees >= 100 ? coffees.toFixed(0) : coffees.toFixed(1)} ☕`}
          detail={`at $${DOLLARS_PER_COFFEE} a cup · ${totals.subagents} subagents spawned`}
        />
      </StatRow>
    </>
  );
}
