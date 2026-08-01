/**
 * Seeds the canonical demo fleet into the **live** `cumulo-sites` table.
 *
 * Why it exists. The deployed table starts empty, and every fleet-level surface
 * — the map, the aggregate forecast, the accuracy metrics — is a view over rows
 * that have to be there first. The 60 sites are not arbitrary test data: they
 * are `generateFleet(canonicalFleetSeed)`, the same fleet the web app's demo
 * source, the ingestion budget tests and `docs/design/fleet-simulation.md` all
 * describe, so seeding makes the deployed system agree with the documented one.
 *
 * Why it is safe to re-run. Every site is written with `putFleetSite`, a plain
 * overwrite, and `buildSeedFleet` is deterministic down to `createdAt` — so a
 * second run rewrites each item with identical bytes. `putFleetSite` also never
 * touches the `#META#counters` item, so seeding cannot consume any part of the
 * 40-site user quota (#29): the counter counts user sites, and these are not.
 * Nor can these sites ever be evicted — `toItem` writes the `user-sites-by-age`
 * index attributes only for `origin: 'user'`, so the seed fleet is invisible to
 * eviction structurally rather than by a filter. `seed/seed-sites.test.ts` pins
 * both of those properties in `pnpm test`.
 *
 * Why it is not a test. Like `smoke.ts`, it needs an operator's AWS session and
 * writes to real tables, so it is deliberately absent from `pnpm test` and from
 * the root `pnpm verify` gate: that gate runs in CI, where the OIDC role holds
 * zero DynamoDB permissions by design and must keep holding zero. It *is*
 * covered by `pnpm typecheck` (the package tsconfig includes `scripts`), and the
 * pure half of it is covered by unit tests, so it cannot rot silently.
 *
 * Usage: `AWS_PROFILE=… CUMULO_ENV=dev pnpm --filter @cumulo/storage seed:fleet`.
 * Prints one `PASS`/`FAIL` line per phase and exits non-zero if either failed.
 */

import { deepStrictEqual } from 'node:assert/strict';

import { locationId } from '@cumulo/shared';

import { SiteAdapter, createStorageDocumentClient, storageTableName } from '../src/index';

import { buildSeedFleet } from './seed/seed-sites';
import { assertAwsSession } from './smoke/aws-session';
import { CheckRunner, describeError, eventually } from './smoke/check-runner';
import { ENVIRONMENT } from './storage-environment';

/** The ingestion cycle's cadence — `cron(7 * * * ? *)` in `infra/ingestion/schedule.tf`. */
const HOURLY_CYCLES_PER_DAY = 24;

/** Open-Meteo's free-tier ceiling, the hard constraint in CLAUDE.md. */
const OPEN_METEO_DAILY_CALL_ALLOWANCE = 10_000;

const client = createStorageDocumentClient();
const runner = new CheckRunner();
const fleet = buildSeedFleet();
const siteCount = String(fleet.length);

try {
  const region = await assertAwsSession(client);
  const tableName = storageTableName('sites', ENVIRONMENT);
  console.log(`Seed: environment '${ENVIRONMENT}', region ${region}, table ${tableName}`);

  const sites = new SiteAdapter({ client, tableName });

  await runner.check(`seeded ${siteCount} sites`, async () => {
    // Sequentially, on purpose: 60 single-item writes are seconds of wall clock
    // and an operator reads a failure far more easily when the write that failed
    // is the last one attempted. `putFleetSite` throws a `StorageError` naming
    // the site key, so nothing is lost by stopping at the first one.
    for (const site of fleet) {
      await sites.putFleetSite(site);
    }
  });

  await runner.check(`verified ${siteCount} seed sites present`, async () => {
    const listed = await eventually(
      'sites: every seeded site is in the fleet listing',
      () => sites.listFleetSites(),
      (found) => {
        const ids = new Set(found.map((site) => site.id));
        return fleet.every((site) => ids.has(site.id));
      },
    );

    // Deep equality per site rather than an id check: it proves `origin: 'seed'`
    // and every physics field survived the round trip, and it reads back only
    // the sites we seeded, so user sites sharing the partition are ignored
    // rather than mistaken for drift.
    const stored = new Map(listed.map((site) => [site.id, site]));
    for (const site of fleet) {
      deepStrictEqual(stored.get(site.id), site, `seeded site ${site.id} differs in the table`);
    }
  });

  const locations = new Set(fleet.map((site) => locationId(site))).size;
  const callsPerDay = locations * HOURLY_CYCLES_PER_DAY;
  console.log(
    `Seed: ${String(locations)} locations × ${String(HOURLY_CYCLES_PER_DAY)} hourly cycles = ` +
      `${String(callsPerDay)} Open-Meteo calls/day of the ` +
      `${OPEN_METEO_DAILY_CALL_ALLOWANCE.toLocaleString('en-GB')} allowance`,
  );

  const failures = runner.failureCount;
  console.log(failures === 0 ? 'Seed: fleet seeded' : `Seed: ${String(failures)} phase(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  // The preflight. Nothing below it is worth attempting, so it is reported once
  // and the process fails (error-handling rule 2c).
  console.error(`FAIL  seed could not run — ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
