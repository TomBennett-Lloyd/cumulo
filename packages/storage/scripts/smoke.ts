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
 *
 * This file is the entry point and stays one: the checks themselves live in
 * `scripts/smoke/`, one module per table plus the runner and the teardown.
 */

import { randomUUID } from 'node:crypto';

import { createStorageDocumentClient } from '../src/index';

import { assertAwsSession } from './smoke/aws-session';
import { CheckRunner, describeError } from './smoke/check-runner';
import { runSeriesChecks } from './smoke/series-checks';
import { runSiteChecks } from './smoke/site-checks';
import { runTeardown } from './smoke/teardown';
import { ENVIRONMENT } from './storage-environment';
import { runWeatherChecks } from './smoke/weather-checks';

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
