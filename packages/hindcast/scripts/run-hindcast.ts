/**
 * Operator CLI: replay the physics model over one site's archived weather for
 * one past period, and publish the resulting error metrics.
 *
 * Why this exists. `runHindcast` is a pure orchestration over three injected
 * ports; something has to decide which DynamoDB tables those ports address,
 * which Open-Meteo policy the archive fetch runs under, and what `issuedAt` a
 * run stamps its metrics with. That is this file, and only this file — the
 * composition root, in the same shape `apps/ingestion/src/main.ts` uses.
 *
 * Why it is not a test. It needs an operator's AWS session, it writes to real
 * tables, and it spends Open-Meteo archive quota against the free-tier budget
 * CLAUDE.md treats as a hard constraint. So it is deliberately absent from
 * `pnpm test` and from the root `pnpm verify` gate, which runs in CI where the
 * OIDC role holds no DynamoDB permissions by design. It *is* covered by
 * `pnpm typecheck` — the package tsconfig includes `scripts` — so it cannot rot
 * silently against the adapters it wires together. That type check is doing real
 * work here beyond catching typos: this is the one place the real
 * `WeatherAdapter` is compiled against `@cumulo/hindcast`'s `ArchiveDayStore`
 * and `ArchiveReadingStore` ports, which the library declares for itself rather
 * than importing from an AWS-bearing package.
 *
 * Usage:
 *
 *   AWS_PROFILE=… CUMULO_ENV=dev pnpm --filter @cumulo/hindcast hindcast -- \
 *     --site site.json --observations observations.json \
 *     --from 2026-05-01T00:00:00Z --to 2026-06-01T00:00:00Z
 *
 * `site.json` is one `siteSchema` object; `observations.json` is an array of
 * `generationReadingSchema` objects for that same site — including, ideally, the
 * day before `--from`, which is what the persistence baseline needs to score the
 * period's first day. Prints the metrics and what the run cost, and exits
 * non-zero on any outcome other than a completed evaluation.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  generationReadingSchema,
  siteSchema,
  utcIsoTimestampSchema,
  type MetricsPeriod,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import {
  MetricsAdapter,
  WeatherAdapter,
  createStorageDocumentClient,
  storageTableName,
} from '@cumulo/storage';
import { z } from 'zod';

import {
  fetchArchiveDays,
  runHindcast,
  type ArchiveFetchDeps,
  type HindcastDeps,
  type HindcastOutcome,
} from '../src/index';

const USAGE =
  'Usage: AWS_PROFILE=… CUMULO_ENV=dev pnpm --filter @cumulo/hindcast hindcast -- ' +
  '--site site.json --observations observations.json ' +
  '--from 2026-05-01T00:00:00Z --to 2026-06-01T00:00:00Z';

/** Which set of tables to talk to — `cumulo-<table>-<environment>`, as the smoke script does. */
const ENVIRONMENT = process.env.CUMULO_ENV ?? 'dev';

const observationsSchema = z.array(generationReadingSchema);

/**
 * The backfill runs Open-Meteo on the adapter's own timeout — an archive request
 * against a free tier is exactly the shape those defaults were argued for.
 * Stated as an empty override rather than left implicit at the call site,
 * because "this entry point overrides nothing" is a decision the composition
 * root owns and the next reader will want to see made.
 */
const ARCHIVE_POLICY: ArchiveFetchDeps = {};

/**
 * A throw rather than a value: a missing argument is an operator who has not
 * finished typing the command, not an outcome a hindcast could report
 * (`docs/standards/error-handling.md` rule 1). The usage line rides along so the
 * fix is in the same message as the complaint.
 */
const requireOption = (name: string, value: string | undefined): string => {
  if (value === undefined) {
    throw new Error(`Missing --${name}\n${USAGE}`);
  }
  return value;
};

/** File contents as `unknown` — a schema parse is the only thing allowed to give it a type. */
const readJsonFile = async (path: string): Promise<unknown> => {
  const contents: unknown = JSON.parse(await readFile(path, 'utf8'));
  return contents;
};

/**
 * The one clock read in the whole hindcast, here at the edge. `toISOString`
 * always emits milliseconds, which `utcIsoTimestampSchema` rejects on purpose,
 * so they are stripped before the parse.
 */
const nowUtc = (): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

const describeError = (error: unknown): string => {
  const chain: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    chain.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return chain.length === 0 ? String(error) : chain.join(' <- ');
};

const report = (outcome: HindcastOutcome): void => {
  if (outcome.status !== 'complete') {
    // Both non-complete outcomes are refusals to compute, and both left the
    // metrics table untouched — which is the part an operator must not have to
    // infer. The detail says which days are missing or what stopped the fetch.
    console.error(`No metrics written: ${outcome.status}`);
    console.error(outcome.status === 'archive-incomplete' ? JSON.stringify(outcome.detail) : '');
    return;
  }

  const { metrics, coverage } = outcome;
  console.log(`MAE           ${metrics.maeKw.toFixed(3)} kW`);
  console.log(`RMSE          ${metrics.rmseKw.toFixed(3)} kW`);
  console.log(
    `Skill         ${metrics.skillScore === null ? 'n/a — the baseline reached no hour, or made no error' : metrics.skillScore.toFixed(4)} vs ${metrics.baseline}`,
  );
  console.log(`Samples       ${String(metrics.sampleCount)} site-hours`);
  console.log(
    `Archive days  ${String(coverage.alreadyCached)} cached, ${String(coverage.fetched)} fetched, ` +
      `${String(coverage.unavailableDays.length)} unavailable`,
  );
  console.log(`Open-Meteo    ${String(coverage.apiCallCount)} archive request(s) issued`);
  if (coverage.unavailableDays.length > 0) {
    console.log(`Unavailable   ${coverage.unavailableDays.join(', ')}`);
  }
};

const client = createStorageDocumentClient();

try {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' },
      observations: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
    },
  });

  const site = siteSchema.parse(await readJsonFile(requireOption('site', values.site)));
  const observations = observationsSchema.parse(
    await readJsonFile(requireOption('observations', values.observations)),
  );
  const period: MetricsPeriod = {
    startInclusive: utcIsoTimestampSchema.parse(requireOption('from', values.from)),
    endExclusive: utcIsoTimestampSchema.parse(requireOption('to', values.to)),
  };

  /**
   * The adapters go in as whole objects, never as `adapter.queryArchiveRange`:
   * they hold their client and table name on `this`, so a detached method would
   * arrive at the run already broken (`docs/standards/architecture.md` rule 7).
   * One document client for both — a shared connection pool, and one place the
   * storage failure policy is set.
   */
  const deps: HindcastDeps = {
    weatherAdapter: new WeatherAdapter({
      client,
      tableName: storageTableName('weather', ENVIRONMENT),
    }),
    metricsAdapter: new MetricsAdapter({
      client,
      tableName: storageTableName('metrics', ENVIRONMENT),
    }),
    // The adapter is a function of (policy, location, range); the run's
    // dependency is the call for one range. Binding the policy here is the whole
    // of that difference, and it is the composition root's job.
    fetchArchiveRun: (coords, firstDay, lastDay) =>
      fetchArchiveDays(ARCHIVE_POLICY, coords, firstDay, lastDay),
  };

  console.log(
    `Hindcast: environment '${ENVIRONMENT}', site ${site.id} (${site.name}), ` +
      `${period.startInclusive} .. ${period.endExclusive}, ` +
      `${String(observations.length)} observation(s)`,
  );

  const outcome = await runHindcast(deps, {
    site,
    period,
    observations,
    // The clock is read once, here at the edge, and handed in as data. Every
    // step below it is a function of its arguments and reproducible from them.
    issuedAt: nowUtc(),
  });

  report(outcome);
  process.exitCode = outcome.status === 'complete' ? 0 : 1;
} catch (error) {
  // The top-level boundary (`docs/standards/error-handling.md` rule 2c): a bad
  // argument, an unparseable input file, a storage outage or a moved provider
  // contract all land here, get reported with their cause chain, and fail the
  // process. Nothing above this is worth continuing past.
  console.error(`FAIL  hindcast could not run — ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
