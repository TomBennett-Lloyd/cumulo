/**
 * Operator smoke test for `@cumulo/storage` against **live** DynamoDB tables.
 *
 * Why this exists at all. The adapter unit tests prove what a mock can prove:
 * which command inputs we build and how we interpret the responses. They cannot
 * prove that DynamoDB agrees — that a sparse GSI really omits the sites we
 * never wrote the index attribute for, that a `BETWEEN` whose upper bound is a
 * bare `T#<timestamp>` really excludes the items at that timestamp, that a
 * transaction really lands the archive marker with its readings. Those are
 * properties of the service, and only the service can be asked. This script
 * asks it, once, by hand (ADR 0002 / the #13 plan's Phase B).
 *
 * Why it is not a test. It needs an operator's AWS session and it writes to
 * real tables, so it is deliberately absent from `pnpm test` and from the root
 * `pnpm verify` gate: that gate runs in CI, where the OIDC role holds zero
 * DynamoDB permissions by design and must keep holding zero. A smoke check
 * wired into `verify` would be an argument for granting them. It *is* covered
 * by `pnpm typecheck` (the package tsconfig includes `scripts`), so it cannot
 * rot silently against the adapter surface it exercises.
 *
 * Usage: `AWS_PROFILE=… CUMULO_ENV=dev pnpm --filter @cumulo/storage smoke`.
 * Prints one `PASS`/`FAIL` line per check, exits non-zero if any failed, and
 * leaves nothing behind — the last checks re-read the partitions it wrote to
 * and assert they are empty again.
 */

import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, NativeAttributeValue } from '@aws-sdk/lib-dynamodb';
import {
  archiveDayMarkerSortKey,
  fleetSiteSchema,
  forecastSchema,
  generationReadingSchema,
  locationId,
  seriesSortKey,
  utcIsoTimestampSchema,
  weatherReadingSchema,
  weatherSortKey,
} from '@cumulo/shared';
import type {
  FleetSite,
  Forecast,
  ForecastModel,
  GenerationReading,
  UtcIsoTimestamp,
  WeatherReading,
} from '@cumulo/shared';

import {
  createSeriesAdapter,
  createSiteAdapter,
  createStorageDocumentClient,
  createWeatherAdapter,
  storageTableName,
} from '../src/index';
import type {
  ArchiveWeatherReading,
  ForecastWeatherReading,
  SeriesPoint,
  SitePhysics,
} from '../src/index';

/** Which set of tables to talk to — `cumulo-<table>-<environment>`. */
const ENVIRONMENT = process.env.CUMULO_ENV ?? 'dev';

/**
 * Null Island, and a day two decades before this project existed.
 *
 * Both are chosen to be unreachable by real data. The fleet is a
 * British-and-Irish rooftop simulation, so no site rounds to `0.00,0.00`, and
 * nothing ever asks Open-Meteo for 1999 — so a smoke run cannot collide with,
 * or accidentally delete, anything the platform wrote. The 1999 timestamps
 * carry a second benefit: series and forecast-weather items get
 * `expiresAt = validTime + 90 days`, long past, so anything a crashed run
 * leaves behind is swept by DynamoDB's TTL rather than living forever.
 */
const SMOKE_LOCATION = { latitude: 0, longitude: 0 };
const SMOKE_DAY = '1999-01-01';
const UNFETCHED_DAY = '1999-01-02';

const timestamp = (value: string): UtcIsoTimestamp => utcIsoTimestampSchema.parse(value);

const HOUR_0 = timestamp(`${SMOKE_DAY}T00:00:00Z`);
const HOUR_1 = timestamp(`${SMOKE_DAY}T01:00:00Z`);
const HOUR_2 = timestamp(`${SMOKE_DAY}T02:00:00Z`);

/**
 * How long to keep re-reading before calling a mismatch a failure.
 *
 * Every read here is eventually consistent — `ConsistentRead` is set nowhere in
 * this package (ADR 0002 Consequence 3) and a GSI cannot be read consistently
 * at all — so "I just wrote it and it is not there yet" is a legitimate answer
 * for a short while, and a script that asserted immediately would fail for the
 * wrong reason. Twenty seconds is far beyond DynamoDB's normal replication lag,
 * so exhausting it is a real result, not a flaky one.
 */
const SETTLE_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

/** Renders an error and its `cause` chain — a `StorageError` says nothing useful without it. */
function describeError(error: unknown): string {
  const chain: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    chain.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return chain.length === 0 ? String(error) : chain.join(' <- ');
}

/**
 * Runs one check and reports it on its own line.
 *
 * This is the top-level boundary handler of `docs/standards/error-handling.md`
 * rule 2c, applied per check rather than per run: the point of a smoke script is
 * to report *everything* that is broken in one pass, so a failing check records
 * itself and the run continues. Nothing is swallowed — the failure count is what
 * the process exits on.
 */
class CheckRunner {
  private failures = 0;

  async check(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      console.log(`PASS  ${name}`);
    } catch (error) {
      this.failures += 1;
      console.error(`FAIL  ${name} — ${describeError(error)}`);
    }
  }

  get failureCount(): number {
    return this.failures;
  }
}

/** Re-reads until the answer satisfies `settled`, or the settle budget runs out. */
async function eventually<TValue>(
  what: string,
  read: () => Promise<TValue>,
  settled: (value: TValue) => boolean,
): Promise<TValue> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (settled(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${what}: still not true after ${String(SETTLE_TIMEOUT_MS)} ms of eventually-consistent re-reads`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Counts every item in one partition, straight through the document client.
 *
 * Deliberately *not* an adapter call: this is the residue check, and its whole
 * job is to see anything the adapters would not surface — an item under a sort
 * key no adapter queries, a marker left by a half-finished transaction. An
 * adapter-shaped read would only find what the adapters already know to look
 * for, which is exactly the wrong instrument for "is there anything left?".
 */
async function countPartitionItems(
  client: DynamoDBDocumentClient,
  tableName: string,
  partitionAttribute: string,
  partitionValue: string,
): Promise<number> {
  let count = 0;
  let cursor: Record<string, NativeAttributeValue> | undefined;

  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#pk = :pk',
        // The attribute name is a variable here (`siteId` or `locationId`), so
        // it goes through a placeholder rather than string-concatenation.
        ExpressionAttributeNames: { '#pk': partitionAttribute },
        ExpressionAttributeValues: { ':pk': partitionValue },
        Select: 'COUNT',
        ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
      }),
    );
    count += page.Count ?? 0;
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);

  return count;
}

/**
 * Deletes one item by key, straight through the document client.
 *
 * Neither the series nor the weather adapter offers a delete: range deletion
 * and eviction are #29's scope, and inventing a public delete here to make the
 * script tidy would be shipping API surface nobody asked for. So teardown
 * addresses items directly — but it builds their keys with the same
 * `@cumulo/shared` key functions the adapters write them with, so a key-format
 * change cannot leave this script deleting the wrong thing (or nothing).
 */
async function deleteItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: Record<string, string>,
): Promise<void> {
  await client.send(new DeleteCommand({ TableName: tableName, Key: key }));
}

function smokeSite(siteId: string): FleetSite {
  return fleetSiteSchema.parse({
    id: siteId,
    name: 'storage smoke test site',
    ...SMOKE_LOCATION,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw: 4,
    origin: 'user',
    createdAt: HOUR_0,
    active: true,
  });
}

function smokeForecast(siteId: string, validTime: UtcIsoTimestamp, model: ForecastModel): Forecast {
  return forecastSchema.parse({
    siteId,
    model,
    validTime,
    issuedAt: HOUR_0,
    weatherSource: 'open-meteo',
    poaIrradianceWm2: 120,
    acPowerKw: 1.5,
  });
}

function smokeGeneration(siteId: string, validTime: UtcIsoTimestamp): GenerationReading {
  return generationReadingSchema.parse({ siteId, validTime, acPowerKw: 1.2 });
}

function smokeWeather(validTime: UtcIsoTimestamp, kind: WeatherReading['kind']): WeatherReading {
  return weatherReadingSchema.parse({
    ...SMOKE_LOCATION,
    validTime,
    kind,
    source: 'open-meteo',
    shortwaveRadiationWm2: 100,
    directRadiationWm2: 60,
    diffuseRadiationWm2: 40,
    directNormalIrradianceWm2: 80,
    temperature2mC: 12,
    windSpeed10mMs: 3,
    cloudCoverPct: 50,
  });
}

// `kind` is restated after the parse purely to narrow the type: the adapters
// take `kind`-narrowed readings so that a forecast reading cannot be handed to
// the archive writer, and a schema parse widens back to the union. Restating the
// literal is how that narrowing is recovered without a type assertion.
const smokeArchiveReading = (validTime: UtcIsoTimestamp): ArchiveWeatherReading => ({
  ...smokeWeather(validTime, 'archive'),
  kind: 'archive',
});

const smokeForecastReading = (validTime: UtcIsoTimestamp): ForecastWeatherReading => ({
  ...smokeWeather(validTime, 'forecast'),
  kind: 'forecast',
});

/** A `SeriesPoint` rendered as one comparable string, so order assertions read as data. */
function describePoint(point: SeriesPoint): string {
  return point.type === 'forecast'
    ? `forecast:${point.forecast.model}@${point.forecast.validTime}`
    : `generation@${point.reading.validTime}`;
}

/**
 * Confirms there is a usable AWS session before a single command is built.
 *
 * Without this the first failure would be an adapter's `StorageError` wrapping
 * a provider-chain rejection several frames down, which reads like a bug in the
 * storage layer. Credentials are checked before region because a missing
 * session is the overwhelmingly likely reason someone sees this script fail.
 */
async function assertAwsSession(client: DynamoDBDocumentClient): Promise<string> {
  try {
    await client.config.credentials();
  } catch (cause) {
    throw new Error(
      'No AWS credentials: this script talks to live DynamoDB tables and cannot run without an operator session. Sign in (e.g. `aws sso login --profile <profile>`) and re-run with AWS_PROFILE set.',
      { cause },
    );
  }

  try {
    return await client.config.region();
  } catch (cause) {
    throw new Error(
      'No AWS region: set AWS_REGION (or a profile whose config sets one) to the region holding the cumulo storage stack — the same value as `aws_region` in infra/storage.',
      { cause },
    );
  }
}

async function runSiteChecks(
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
  siteId: string,
): Promise<void> {
  const sites = createSiteAdapter({ client, tableName: storageTableName('sites', ENVIRONMENT) });
  const site = smokeSite(siteId);
  const location = locationId(site);

  await runner.check('sites: put then get returns the identical site', async () => {
    await sites.putFleetSite(site);
    const found = await eventually(
      'sites: the site we just wrote is readable',
      () => sites.getFleetSite(siteId),
      (result) => result.found,
    );
    ok(found.found, 'expected the site to be found');
    // Deep equality is the real assertion: it proves every domain field survived
    // the round trip through the key attributes `toItem` adds and `fromItem`
    // strips, and that none of those attributes leaked back in as domain data.
    deepStrictEqual(found.site, site, 'the site read back differs from the one written');
  });

  await runner.check('sites: the sparse by-location GSI projects the physics fields', async () => {
    const physics = await eventually(
      'sites: the by-location index has caught up',
      () => sites.listActiveSitePhysicsAtLocation(location),
      (found) => found.some((entry) => entry.id === siteId),
    );
    const mine = physics.find((entry) => entry.id === siteId);
    const expected: SitePhysics = {
      id: site.id,
      latitude: site.latitude,
      longitude: site.longitude,
      tiltDegrees: site.tiltDegrees,
      azimuthDegrees: site.azimuthDegrees,
      capacityKw: site.capacityKw,
    };
    // If the INCLUDE projection in infra/storage/tables.tf ever stops covering a
    // physics field, the parse behind this call fails here and nowhere else —
    // no mock can notice a projection that omits an attribute.
    deepStrictEqual(mine, expected, 'the projected physics attributes are not what F1 needs');
  });

  await runner.check('sites: listFleetSites contains the site', async () => {
    const fleet = await eventually(
      'sites: the fleet list contains the site',
      () => sites.listFleetSites(),
      (found) => found.some((entry) => entry.id === siteId),
    );
    deepStrictEqual(
      fleet.find((entry) => entry.id === siteId),
      site,
      'the site in the fleet listing differs from the one written',
    );
  });
}

async function runSeriesChecks(
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
  siteId: string,
): Promise<void> {
  const series = createSeriesAdapter({
    client,
    tableName: storageTableName('series', ENVIRONMENT),
  });
  const physicsAtHour0 = smokeForecast(siteId, HOUR_0, 'physics');
  const mlAtHour0 = smokeForecast(siteId, HOUR_0, 'ml');
  const generationAtHour1 = smokeGeneration(siteId, HOUR_1);

  await runner.check('series: batch writes drain completely', async () => {
    const forecasts = await series.putForecasts([physicsAtHour0, mlAtHour0]);
    equal(forecasts.status, 'complete', 'the forecast batch did not drain');
    const readings = await series.putGenerationReadings([generationAtHour1]);
    equal(readings.status, 'complete', 'the generation batch did not drain');
  });

  await runner.check(
    'series: querySeriesRange is half-open — the upper bound excludes its own hour',
    async () => {
      // The one behaviour a mock genuinely cannot check: whether real DynamoDB
      // agrees that `T#<hour1>` sorts below `T#<hour1>#GEN`. If it did not, this
      // window would return three points and the dashboard would double-count
      // the boundary hour of every adjacent range.
      const window = await eventually(
        'series: both hour-0 forecasts are readable',
        () => series.querySeriesRange(siteId, HOUR_0, HOUR_1),
        (points) => points.length === 2,
      );
      deepStrictEqual(
        window.map(describePoint),
        [`forecast:ml@${HOUR_0}`, `forecast:physics@${HOUR_0}`],
        'the [hour0, hour1) window is not exactly the two hour-0 forecasts, in sort-key order',
      );
    },
  );

  await runner.check(
    'series: a wider range interleaves forecasts and actuals by time',
    async () => {
      const window = await eventually(
        'series: all three points are readable',
        () => series.querySeriesRange(siteId, HOUR_0, HOUR_2),
        (points) => points.length === 3,
      );
      deepStrictEqual(
        window.map(describePoint),
        [`forecast:ml@${HOUR_0}`, `forecast:physics@${HOUR_0}`, `generation@${HOUR_1}`],
        'the [hour0, hour2) window is not the three points in chronological order',
      );
    },
  );

  await runner.check(
    'series: querySeriesFrom returns the points at or after its bound',
    async () => {
      const points = await eventually(
        'series: the hour-1 reading is readable',
        () => series.querySeriesFrom(siteId, HOUR_1, 10),
        (found) => found.length === 1,
      );
      deepStrictEqual(
        points.map(describePoint),
        [`generation@${HOUR_1}`],
        'querySeriesFrom returned something other than the single hour-1 actual',
      );
    },
  );
}

async function runWeatherChecks(
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
): Promise<void> {
  const weather = createWeatherAdapter({
    client,
    tableName: storageTableName('weather', ENVIRONMENT),
  });
  const archiveHours = [smokeArchiveReading(HOUR_0), smokeArchiveReading(HOUR_1)];

  await runner.check('weather: putArchiveDay writes the day and its marker', async () => {
    await weather.putArchiveDay(SMOKE_DAY, archiveHours);
  });

  await runner.check('weather: the day marker is visible and the next day is not', async () => {
    const coverage = await eventually(
      'weather: the archive-day marker is readable',
      () => weather.listFetchedArchiveDays(SMOKE_LOCATION, [SMOKE_DAY, UNFETCHED_DAY]),
      (found) => found.fetched.has(SMOKE_DAY),
    );
    equal(coverage.status, 'complete', 'BatchGet left keys undetermined');
    ok(!coverage.fetched.has(UNFETCHED_DAY), 'a day that was never written reports as fetched');
  });

  await runner.check('weather: queryArchiveRange returns the day, markers excluded', async () => {
    const readings = await eventually(
      'weather: both archive hours are readable',
      () => weather.queryArchiveRange(SMOKE_LOCATION, HOUR_0, HOUR_2),
      (found) => found.length === 2,
    );
    // Not merely a count: the marker shares the partition and sorts adjacent to
    // these items, so "two weather readings, in order" is what proves the sort
    // key really keeps `ARCHIVE#DAY#…` out of `ARCHIVE#T#…` range reads.
    deepStrictEqual(
      readings.map((reading) => reading.validTime),
      [HOUR_0, HOUR_1],
      'the archive range is not the two hours written, in order',
    );
    deepStrictEqual(readings, archiveHours, 'an archive reading changed across the round trip');
  });

  await runner.check('weather: the archive range is half-open at its upper bound', async () => {
    const readings = await weather.queryArchiveRange(SMOKE_LOCATION, HOUR_0, HOUR_1);
    deepStrictEqual(
      readings.map((reading) => reading.validTime),
      [HOUR_0],
      'the [hour0, hour1) window included the reading at hour 1',
    );
  });

  await runner.check('weather: forecast weather batch-writes completely', async () => {
    const outcome = await weather.putForecastWeather([smokeForecastReading(HOUR_0)]);
    equal(outcome.status, 'complete', 'the forecast-weather batch did not drain');
  });
}

/**
 * Removes everything the checks wrote, then proves it. Runs whatever happened
 * above — a run that failed halfway is exactly the run most likely to have left
 * items behind.
 */
async function runTeardown(
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
  siteId: string,
): Promise<void> {
  const sitesTable = storageTableName('sites', ENVIRONMENT);
  const seriesTable = storageTableName('series', ENVIRONMENT);
  const weatherTable = storageTableName('weather', ENVIRONMENT);
  const sites = createSiteAdapter({ client, tableName: sitesTable });
  const partitionKey = locationId(SMOKE_LOCATION);

  await runner.check('cleanup: the site is deleted and no longer readable', async () => {
    const { deleted } = await sites.deleteFleetSite(siteId);
    ok(deleted, 'deleteFleetSite reported nothing to delete');
    const result = await eventually(
      'cleanup: the deleted site is gone',
      () => sites.getFleetSite(siteId),
      (found) => !found.found,
    );
    ok(!result.found, 'the site is still readable after deletion');
  });

  await runner.check('cleanup: the site left the by-location index', async () => {
    await eventually(
      'cleanup: the by-location index no longer lists the site',
      () => sites.listActiveSitePhysicsAtLocation(partitionKey),
      (found) => !found.some((entry) => entry.id === siteId),
    );
  });

  await runner.check('cleanup: the series partition is empty', async () => {
    for (const sortKey of [
      seriesSortKey(HOUR_0, { kind: 'forecast', model: 'physics' }),
      seriesSortKey(HOUR_0, { kind: 'forecast', model: 'ml' }),
      seriesSortKey(HOUR_1, { kind: 'generation' }),
    ]) {
      await deleteItem(client, seriesTable, { siteId, sk: sortKey });
    }
    const remaining = await eventually(
      'cleanup: the series partition drained',
      () => countPartitionItems(client, seriesTable, 'siteId', siteId),
      (count) => count === 0,
    );
    equal(remaining, 0, 'series items survived cleanup');
  });

  await runner.check('cleanup: the weather partition is empty', async () => {
    for (const sortKey of [
      weatherSortKey('archive', HOUR_0),
      weatherSortKey('archive', HOUR_1),
      weatherSortKey('forecast', HOUR_0),
      archiveDayMarkerSortKey(SMOKE_DAY),
    ]) {
      await deleteItem(client, weatherTable, { locationId: partitionKey, sk: sortKey });
    }
    const remaining = await eventually(
      'cleanup: the weather partition drained',
      () => countPartitionItems(client, weatherTable, 'locationId', partitionKey),
      (count) => count === 0,
    );
    equal(remaining, 0, 'weather items survived cleanup');
  });
}

const client = createStorageDocumentClient();
const runner = new CheckRunner();
const siteId = randomUUID();

try {
  const region = await assertAwsSession(client);
  console.log(`Smoke: environment '${ENVIRONMENT}', region ${region}, site ${siteId}`);

  try {
    await runSiteChecks(runner, client, siteId);
    await runSeriesChecks(runner, client, siteId);
    await runWeatherChecks(runner, client);
  } finally {
    await runTeardown(runner, client, siteId);
  }

  const failures = runner.failureCount;
  console.log(
    failures === 0 ? 'Smoke: all checks passed' : `Smoke: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  // The preflight, or a teardown that could not even run. Nothing here is
  // recoverable and nothing above it is worth attempting, so it is reported once
  // and the process fails (error-handling rule 2c).
  console.error(`FAIL  smoke could not run — ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
