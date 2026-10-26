/**
 * The month calendar of the news (M14.11), in the popup of the heading's Calendar button: the days
 * with articles, shaded by how many. A day narrows the paper and the table to itself; the same day
 * again lets it go. The arrows stop where the window does.
 */
import type { NewsItemView } from "@swarm/core/newsfeed";
import { useState } from "react";
import {
  compareMonths,
  dayKey,
  heat,
  type Month,
  monthGrid,
  monthLabel,
  monthOf,
  shiftMonth,
  WEEKDAYS,
} from "../../lib/calendar";
import { countByDay, dayLabel } from "./tiers";

/** `3 articles over 2 days this month`, or `3 articles this month` when every day holds one. */
function footOf(total: number, days: number): string {
  const what = `${total} article${total === 1 ? "" : "s"}`;
  if (total === days) return `${what} this month`;
  return `${what} over ${days} day${days === 1 ? "" : "s"} this month`;
}

export function NewsCalendar({
  items,
  day,
  onDay,
  bare,
}: {
  items: readonly NewsItemView[];
  /** Inside a popup, which is already the frame: no border or shadow of its own. */
  bare?: boolean;
  /** The selected day, or "" for every day. */
  day: string;
  onDay: (day: string) => void;
}) {
  const [turned, setTurned] = useState<Month | null>(null);
  const counts = countByDay(items);
  const days = [...counts.keys()].sort();
  const today = dayKey(new Date());
  const first = days[0] ?? today;
  const last = days[days.length - 1] ?? today;
  const month = turned ?? monthOf(day || last);
  const span: [Month, Month] = [monthOf(first), monthOf(last)];

  const weeks = monthGrid(month);
  const countOf = (key: string) => counts.get(key) ?? 0;
  const inView = weeks.flat().filter((key): key is string => Boolean(key));
  const busiest = Math.max(0, ...inView.map(countOf));
  const written = inView.filter((key) => countOf(key) > 0);
  const total = written.reduce((sum, key) => sum + countOf(key), 0);
  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

  return (
    <div className={bare ? "mcal bare" : "mcal"}>
      <div className="mcal-h">
        <button
          type="button"
          className="mcal-nav"
          onClick={() => setTurned(previous)}
          disabled={compareMonths(previous, span[0]) < 0}
          aria-label="The month before"
        >
          ‹
        </button>
        <b>{monthLabel(month)}</b>
        <button
          type="button"
          className="mcal-nav"
          onClick={() => setTurned(next)}
          disabled={compareMonths(next, span[1]) > 0}
          aria-label="The month after"
        >
          ›
        </button>
      </div>
      <table className="mcal-grid">
        <thead>
          <tr>
            {WEEKDAYS.map((initial, i) => (
              // The initials repeat (two Ts, two Ss), so the column's position is the key.
              // biome-ignore lint/suspicious/noArrayIndexKey: a weekday is its position in the week
              <th key={i} className="wd" scope="col">
                {initial}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.find(Boolean) ?? "empty"}>
              {week.map((key, i) => (
                <td key={key ?? `pad-${i}`} className="cell">
                  {key && (
                    <CalendarDay
                      dayKey={key}
                      count={countOf(key)}
                      busiest={busiest}
                      selected={key === day}
                      onDay={onDay}
                    />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mcal-foot">{footOf(total, written.length)}</p>
    </div>
  );
}

/** One day of the grid: a plain number on a day with nothing, else a button shaded by its count. */
function CalendarDay({
  dayKey: key,
  count,
  busiest,
  selected,
  onDay,
}: {
  dayKey: string;
  count: number;
  busiest: number;
  selected: boolean;
  onDay: (day: string) => void;
}) {
  const dayOfMonth = Number(key.slice(8));
  if (!count) return <span className="mcal-day empty">{dayOfMonth}</span>;
  return (
    <button
      type="button"
      className={`mcal-day h${heat(count, busiest)}${selected ? " on" : ""}`}
      onClick={() => onDay(selected ? "" : key)}
      aria-pressed={selected}
      title={`${dayLabel(key)}: ${count} article${count === 1 ? "" : "s"}`}
    >
      {dayOfMonth}
    </button>
  );
}
