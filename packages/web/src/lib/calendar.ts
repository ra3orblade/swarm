/**
 * The month grid the news is browsed by (M14.11). Everything here is UTC, like the stamps the
 * daemon stores: an article published at 23:30 belongs to the day it names, wherever the reader is.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Monday first. */
export const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

const two = (n: number) => String(n).padStart(2, "0");

/** A month, as the only two numbers that identify one. */
export interface Month {
  year: number;
  /** Zero-based, as `Date` counts them. */
  month: number;
}

/** The UTC day a moment falls on, as `2026-09-16`. */
export const dayKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;

/** The month a day key falls in. */
export const monthOf = (key: string): Month => ({
  year: Number(key.slice(0, 4)),
  month: Number(key.slice(5, 7)) - 1,
});

/** `September 2026`. */
export const monthLabel = ({ year, month }: Month): string => `${MONTHS[month]} ${year}`;

/** The month `n` months later (or earlier, for a negative `n`), rolling over the year as needed. */
export const shiftMonth = ({ year, month }: Month, n: number): Month => {
  const date = new Date(Date.UTC(year, month + n, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
};

/** How a month sorts against another: negative when `a` is earlier. */
export const compareMonths = (a: Month, b: Month) => a.year - b.year || a.month - b.month;

/**
 * A month as the weeks a calendar draws: whole weeks from Monday, with the days outside the month
 * left empty. Showing the neighbouring months' days would invite clicks this month cannot answer.
 */
export const monthGrid = ({ year, month }: Month): Array<Array<string | null>> => {
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // getUTCDay counts from Sunday; shifting by six makes Monday 0 and Sunday 6.
  const leadingBlanks = (first.getUTCDay() + 6) % 7;
  const cells: Array<string | null> = [
    ...Array<null>(leadingBlanks).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${year}-${two(month + 1)}-${two(i + 1)}`),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks = cells.length / 7;
  return Array.from({ length: weeks }, (_, week) => cells.slice(week * 7, week * 7 + 7));
};

/**
 * How dark a day reads against the busiest day in view. Four steps only, so the reader never has
 * to measure a shade. Step 0 is a day with nothing on it.
 */
export const heat = (count: number, busiest: number): 0 | 1 | 2 | 3 => {
  if (count <= 0) return 0;
  if (busiest <= 1) return 3;
  const share = count / busiest;
  if (share > 0.66) return 3;
  if (share > 0.33) return 2;
  return 1;
};
