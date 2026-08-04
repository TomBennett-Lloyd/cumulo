import type { UtcIsoTimestamp } from '@cumulo/shared';

/**
 * DynamoDB TTL: the expiry attribute values written by the series, weather and
 * abuse adapters — the three tables `infra/storage/tables.tf` gives a `ttl`
 * block, and every row in this repo that goes away on its own.
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
 * Every production writer of an expiring item names the attribute through this
 * constant, so the name has one owner on the code side too: the series, weather
 * and abuse item builders and key-attribute sets, the abuse adapter's
 * `UpdateExpression` (a string, where a stale name is not a type error, which
 * is why it interpolates rather than spells), and the smoke check that reads the
 * deployed TTL configuration back.
 *
 * **Restatement ledger** (`docs/standards/architecture.md` rule 9) — every site
 * where the literal `'expiresAt'` is load-bearing: asserted as the wire shape,
 * or (the gate and its harness) declared and doctored, and each would prove
 * nothing if it agreed with the code by construction. Prose mentions of the
 * name — comments, docs, smoke check descriptions — are deliberately not
 * enumerated here (#249 owns that class). Renaming this constant means
 * visiting all of these:
 *
 *   * `infra/storage/tables.tf` — the three `ttl { attribute_name = … }` blocks.
 *     The deployed owner, and the only one this repo can rename without AWS;
 *     held equal to this constant by `check:infra-mirrors`, so it is the one
 *     entry here that fails a build rather than waiting to be visited.
 *   * `adapters/series/series-fixtures.ts` — the stored items written out
 *     literally (that module's own docblock says why), and the series item and
 *     marshalling tests that assert over them.
 *   * `adapters/abuse/abuse-adapter.test.ts` — pins the exact
 *     `UpdateExpression` text DynamoDB is sent, which is the wire shape the
 *     interpolation above must keep producing.
 *   * `adapters/abuse/abuse-item.test.ts`,
 *     `adapters/weather/put-archive-day.test.ts` and
 *     `adapters/weather/put-forecast-weather.test.ts` — items, presences and
 *     absences asserted as DynamoDB would hold them.
 *   * `scripts/smoke/abuse-checks.ts` — reads the expiry back off a live row
 *     typed as `Record<string, NativeAttributeValue>`, so nothing couples it to
 *     this constant at all: a rename leaves it compiling, passing every offline
 *     check, and asserting about an attribute the adapter no longer writes,
 *     until a smoke run against real DynamoDB says otherwise. The weakest link
 *     in this list, and the reason the list exists.
 *   * `.claude/scripts/check-infra-mirrors.sh` — its header prose counts "the
 *     `expiresAt` TTL attribute" as three of its records, and
 *     `check-infra-mirrors.test.sh`'s fixtures restate the name on three
 *     `ttl` blocks and on a stand-in for this constant. Both are deliberate:
 *     a harness generated from the values it checks would follow a rename into
 *     agreement with it. A rename therefore leaves the suite green while it
 *     exercises an abandoned name, which is a harness proving nothing rather
 *     than a harness failing.
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
