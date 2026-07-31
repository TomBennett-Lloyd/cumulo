import type { UtcIsoTimestamp } from '@cumulo/shared';

/**
 * DynamoDB TTL: the `expiresAt` attribute values written by the series and
 * weather adapters.
 *
 * DynamoDB requires TTL to be a Number attribute holding a Unix epoch time in
 * **seconds** — milliseconds are silently never expired, which is the kind of
 * quiet wrongness that only shows up as a storage bill months later.
 */

/**
 * How long a series point (forecast or generation reading) is kept.
 *
 * 90 days is the accuracy-tracking window: long enough for the error metrics
 * this project exists to show, short enough that the `series` table stays
 * inside the always-free 25 GB (ADR 0002).
 */
export const SERIES_RETENTION_DAYS = 90;

const SECONDS_PER_DAY = 86_400;

/**
 * Retention arithmetic is done in UTC seconds, never in calendar days: adding
 * `retentionDays * 86400` to a UTC instant is exact, whereas anything that goes
 * through a local calendar shifts by an hour across a DST boundary.
 */
export function expiresAtEpochSeconds(validTime: UtcIsoTimestamp, retentionDays: number): number {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(
      `expiresAtEpochSeconds: retentionDays must be a positive integer, got ${String(retentionDays)}`,
    );
  }
  const validTimeMs = Date.parse(validTime);
  if (Number.isNaN(validTimeMs)) {
    // Unreachable via the branded schema; a guard against a hand-built value.
    throw new Error(`expiresAtEpochSeconds: validTime is not a parseable instant: '${validTime}'`);
  }
  return Math.floor(validTimeMs / 1000) + retentionDays * SECONDS_PER_DAY;
}
