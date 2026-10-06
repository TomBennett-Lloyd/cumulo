import type { UtcWindow } from '@cumulo/shared';

/**
 * UTC calendar-day arithmetic for hindcast backfill.
 *
 * Pure (`docs/standards/architecture.md` rule 3): no clock, no I/O, no env.
 */

/**
 * A UTC calendar day, zero-padded `YYYY-MM-DD`.
 *
 * An alias rather than a brand: this string is the same value `@cumulo/shared`'s
 * `archiveDayMarkerSortKey` validates and stores, and it travels as a plain
 * `YYYY-MM-DD` through URLs, sort keys and `Map` keys. The alias buys the
 * signature its meaning; the width guarantee is enforced where it bites — at the
 * boundary functions below and at the sort key.
 */
export type UtcDay = string;

/**
 * A closed, contiguous run of UTC days — inclusive at both ends, because that is
 * how Open-Meteo's `start_date`/`end_date` pair is defined. Named and exported
 * (`docs/standards/typing.md` rule 6).
 */
export interface DayRun {
  readonly firstDay: UtcDay;
  readonly lastDay: UtcDay;
}

const MS_PER_DAY = 86_400_000;

/** Zero-padded `YYYY-MM-DD`, the only day spelling anything here accepts. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Days since the Unix epoch — the integer that makes "contiguous" a `+ 1` test. */
const dayIndexOfInstant = (epochMs: number): number => Math.floor(epochMs / MS_PER_DAY);

const dayAtIndex = (dayIndex: number): UtcDay =>
  new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10);

/**
 * Inverse of {@link dayAtIndex}.
 *
 * Throws on anything that is not a real zero-padded UTC day. A day string that
 * cannot be placed on the calendar is a violated invariant — every producer in
 * this package emits `dayAtIndex`'s output — not an expected outcome a caller
 * could act on, so it propagates (`docs/standards/error-handling.md` rule 1).
 */
const dayIndexOfDay = (day: UtcDay): number => {
  const epochMs = DAY_PATTERN.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(epochMs)) {
    throw new Error(`Expected a UTC day as YYYY-MM-DD, received: ${JSON.stringify(day)}`);
  }
  return epochMs / MS_PER_DAY;
};

/**
 * Every UTC calendar day the half-open window `[startInclusive, endExclusive)`
 * touches, in chronological order.
 *
 * Half-open is what makes the day list composable. Two consequences are
 * deliberate and both are pinned by tests:
 * - an `endExclusive` of exactly midnight does **not** include the day it starts,
 *   because the window contains no instant within that day;
 * - an empty or inverted window covers nothing, so it yields no days at all —
 *   never the single day its bounds happen to sit in.
 *
 * The parameter is `UtcWindow` from `@cumulo/shared` rather than a local
 * shape (`docs/standards/architecture.md` rule 2).
 */
export const utcDaysCovering = (period: UtcWindow): UtcDay[] => {
  const startMs = Date.parse(period.startInclusive);
  const endMs = Date.parse(period.endExclusive);
  if (endMs <= startMs) {
    return [];
  }

  const firstIndex = dayIndexOfInstant(startMs);
  // The last covered day is the one holding the final instant *before*
  // `endExclusive`. Ceiling-then-minus-one says exactly that: a midnight bound is
  // already a whole number of days, so it steps back to the previous day, while
  // any bound inside a day rounds up to that day's end and then back onto it.
  const lastIndex = Math.ceil(endMs / MS_PER_DAY) - 1;

  const days: UtcDay[] = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    days.push(dayAtIndex(index));
  }
  return days;
};

const toDayRun = (run: { readonly first: number; readonly last: number }): DayRun => ({
  firstDay: dayAtIndex(run.first),
  lastDay: dayAtIndex(run.last),
});

/**
 * Collapse a set of days into the fewest closed runs that cover them, subject to
 * a maximum run length.
 *
 * This is the frugality step (CLAUDE.md).
 *
 * The cap is a parameter rather than a constant because the number that belongs there
 * is the *provider's* request limit (`MAX_ARCHIVE_REQUEST_DAYS`), which lives with
 * the adapter that knows about the provider, not with calendar arithmetic.
 *
 * Throws on a `maxRunLength` below 1.
 */
export const contiguousDayRuns = (days: readonly UtcDay[], maxRunLength: number): DayRun[] => {
  if (!Number.isInteger(maxRunLength) || maxRunLength < 1) {
    throw new Error(`maxRunLength must be a positive integer, received: ${String(maxRunLength)}`);
  }

  const indices = [...new Set(days)].map(dayIndexOfDay).sort((left, right) => left - right);

  const runs: DayRun[] = [];
  let current: { first: number; last: number } | undefined;

  for (const index of indices) {
    if (current === undefined) {
      current = { first: index, last: index };
      continue;
    }
    const isContiguous = index === current.last + 1;
    const fitsCap = index - current.first + 1 <= maxRunLength;
    if (isContiguous && fitsCap) {
      current = { first: current.first, last: index };
      continue;
    }
    runs.push(toDayRun(current));
    current = { first: index, last: index };
  }

  if (current !== undefined) {
    runs.push(toDayRun(current));
  }
  return runs;
};
