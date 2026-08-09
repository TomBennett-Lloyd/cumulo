import { utcIsoTimestampSchema, type UtcIsoTimestamp } from '@cumulo/shared';

/**
 * Arithmetic on the read windows this folder's routes query over.
 *
 * Extracted from the handlers because they all need it and would be wrong
 * together if it changed (`docs/standards/structure.md` rule 7): two turn a
 * horizon in hours into the far end of a window — forward for the forecast
 * route, backward for the fleet look-back — and the third measures a
 * caller-supplied window to decide whether it is affordable to read.
 */

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * `from` shifted forward by `hours`, in the one timestamp form this system has.
 *
 * The `.replace` is the fixed-width normalization `utcIsoTimestampSchema`
 * demands, and it is load-bearing rather than cosmetic here: `toISOString()`
 * emits milliseconds, and `querySeriesRange` uses the bound as a sort-key
 * prefix, so `…T12:00:00.000Z` would sort *after* every real key at that
 * instant and silently trim the window's last hour (ADR 0002's key design leans
 * on lexicographic order being chronological order).
 *
 * Parsed rather than asserted, so the regex and the brand can never disagree —
 * a normalization that stopped normalizing would throw here instead of
 * returning a plausible-looking string.
 */
export const hoursAfter = (from: UtcIsoTimestamp, hours: number): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(
    new Date(Date.parse(from) + hours * MS_PER_HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  );

/**
 * `from` shifted *backwards* by `hours` — the look-back the fleet-actuals route
 * opens its window at, where the forecast route opens one forward.
 *
 * Defined in terms of {@link hoursAfter} rather than beside it, because the two
 * are one piece of arithmetic read in two directions: the normalization that
 * makes the result a legal sort-key prefix is the part that would be wrong in
 * both if it were wrong in either (`docs/standards/structure.md` rule 7). A
 * second copy of the `.replace` would be a second chance to drop it.
 */
export const hoursBefore = (from: UtcIsoTimestamp, hours: number): UtcIsoTimestamp =>
  hoursAfter(from, -hours);

/**
 * The width of the window `from`…`to` in hours, fractional and signed.
 *
 * Signed rather than absolute: a caller who inverted the bounds gets a negative
 * span, and the route answering that request rejects the inversion on its own
 * terms rather than having this function quietly repair it.
 */
export const spanHours = (from: UtcIsoTimestamp, to: UtcIsoTimestamp): number =>
  (Date.parse(to) - Date.parse(from)) / MS_PER_HOUR;
