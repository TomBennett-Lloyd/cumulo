import { z } from 'zod';

/**
 * An instant in time, as a fixed-width ISO-8601 UTC string to the second.
 *
 * Conventions:
 * - exactly one form is valid: `2026-07-30T14:00:00Z` — date, `T`, time to the
 *   second, `Z` designator
 * - fractional seconds (`...:00.000Z`), minute-only precision (`...T14:00Z`),
 *   numeric offsets (`...:00+00:00`) and a missing designator (`...:00`) are all
 *   invalid, even where they denote the same instant
 *
 * The width is fixed because ADR 0002's range queries rely on lexicographic
 * string order being chronological order. Variable-width or offset-bearing
 * forms break that: `2026-07-30T14:00:00.000Z` sorts after
 * `2026-07-30T14:00:00Z`, and `+01:00` timestamps interleave wrongly with `Z`
 * ones. Normalizing at the boundary means the sort is correct by construction
 * rather than by convention.
 *
 * The type is branded because a timestamp flows four layers deep — weather
 * adapter, forecast core, persistence, API response — as a `string`, where the
 * compiler would otherwise let any unvalidated string take its place.
 */
export const utcIsoTimestampSchema = z.iso.datetime({ precision: 0 }).brand<'UtcIsoTimestamp'>();

export type UtcIsoTimestamp = z.infer<typeof utcIsoTimestampSchema>;

/**
 * A half-open UTC window `[startInclusive, endExclusive)`.
 *
 * The bounds are named rather than positional so two same-shaped timestamps
 * cannot be swapped at a call site, and the interface is exported rather than
 * inlined into any one signature so every consumer conforms to one contract
 * instead of re-declaring the shape (`docs/standards/typing.md` rule 6).
 *
 * It is the shared window contract for both metrics keying — `metricsSortKey`
 * (`storage-key.ts`), whose `errorMetricsSchema.period` (`metrics.ts`) carries
 * exactly this shape — and hindcast day math (`utcDaysCovering` in
 * `@cumulo/hindcast`): the window a hindcast fetches weather for and the window
 * its error metrics are keyed by are the same window.
 *
 * Formerly `MetricsPeriod` in `storage-key.ts`; renamed and moved here by #117
 * once the hindcast consumer made both the `Metrics` prefix and the storage-key
 * home misleading.
 */
export interface UtcWindow {
  readonly startInclusive: UtcIsoTimestamp;
  readonly endExclusive: UtcIsoTimestamp;
}

/**
 * Chronological comparison of two instants, as an `Array.prototype.sort`
 * comparator.
 *
 * It compares the *strings*, and that is correct rather than lazy: the form
 * above is fixed-width UTC by construction, so lexicographic order **is**
 * chronological order — the same property ADR 0002's range queries rest on.
 * Parsing would add nothing and would introduce a second order free to disagree
 * with the one the sort keys are built on.
 *
 * Here rather than in a consumer because the property it exploits is this
 * module's (`docs/standards/architecture.md` rule 9): every caller ordering
 * instants leans on the width guarantee declared a few lines up, so the rule has
 * one implementation and it sits beside the rule. `aggregation.ts` and
 * `fleet-rollup.ts` are its callers today.
 */
export const compareUtcIsoTimestamps = (left: UtcIsoTimestamp, right: UtcIsoTimestamp): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};
