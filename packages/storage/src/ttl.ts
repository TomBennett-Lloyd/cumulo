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

/**
 * The name of the TTL attribute itself, mirrored from Terraform.
 *
 * A mirror, not a source: the `ttl { attribute_name = … }` blocks on
 * `aws_dynamodb_table.series`, `.weather` and `.abuse` in
 * `infra/storage/tables.tf` own the deployed name, and DynamoDB expires rows by
 * *that* name — an item written under any other one is simply never reaped, at
 * no error and no cost signal until the table stops being small. The pair is
 * declared to `.claude/scripts/check-infra-mirrors.sh` (rule 8), so the three
 * tables and this constant are held equal by `pnpm check:infra-mirrors` in the
 * `verify` composite rather than by the comments that cite each other.
 *
 * Every item builder and key-attribute set in this package writes the attribute
 * through this constant, so the name has one owner on the code side too.
 */
export const TTL_ATTRIBUTE_NAME = 'expiresAt';

const SECONDS_PER_DAY = 86_400;

/**
 * Retention arithmetic is done in UTC seconds, never in calendar days: adding
 * `retentionDays * 86400` to a UTC instant is exact, whereas anything that goes
 * through a local calendar shifts by an hour across a DST boundary.
 */
export const expiresAtEpochSeconds = (
  validTime: UtcIsoTimestamp,
  retentionDays: number,
): number => {
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
};
