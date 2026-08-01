import { describeZodIssues, utcIsoTimestampSchema, type UtcIsoTimestamp } from '@cumulo/shared';
import {
  SeriesAdapter,
  SiteAdapter,
  createStorageDocumentClient,
  storageTableName,
} from '@cumulo/storage';
import { z } from 'zod';

import { createHandler, jsonLineLog, type ForecastHandler } from './handler';

/**
 * The composition root, and the module the bundled artifact's `handler` export
 * comes from.
 *
 * Everything that is a *decision* about the running system lives here and only
 * here: which tables, which clock, which log sink, which client. Every module
 * beneath takes its collaborators as parameters, which is what lets the whole
 * message path — including its failure paths — run in a unit test with no AWS in
 * sight (`docs/standards/architecture.md` rule 3).
 *
 * The composition happens at **module scope**, on purpose. AWS reuses a warm
 * container across invocations, so the client built here is built once per
 * container rather than once per message — and, more importantly, a missing or
 * malformed environment variable fails the *initialization*, before any message
 * claims to have been processed. A service that only discovers its table names are
 * nonsense on the first read has already told SQS to redeliver a message that was
 * never going to work.
 */

/**
 * The environment this service requires, as the only place `process.env` is read
 * (`docs/standards/typing.md` rule 3 — external data is `unknown` until parsed).
 *
 * One variable, and the shortness is the point: a queue consumer is *handed* its
 * messages by the event source mapping, so unlike ingestion it never names the
 * queue at runtime and carries no `QUEUE_URL`. `AWS_REGION` is deliberately absent
 * too — Lambda always sets it and the SDK reads it directly, so restating it would
 * create a second dial that can disagree with the region the tables live in.
 *
 * `CUMULO_ENV` is checked only for being non-empty. The alphabet a real environment
 * name has to satisfy is `storageTableName`'s, which mirrors
 * `infra/storage/variables.tf`; restating the pattern here would make three copies
 * of it, and `storageTableName` throws at this same startup with a message naming
 * the offending value.
 */
export const forecastEnvSchema = z.object({
  CUMULO_ENV: z.string().min(1),
});

export type ForecastEnv = z.infer<typeof forecastEnvSchema>;

/**
 * Parse the process environment, or fail loudly.
 *
 * A throw rather than a value (`docs/standards/error-handling.md` rule 1): a
 * missing environment suffix is a deployment that is wrong, not an outcome a
 * message could handle.
 */
export const parseForecastEnv = (source: Record<string, string | undefined>): ForecastEnv => {
  const parsed = forecastEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`forecast: invalid environment — ${describeZodIssues(parsed.error)}`);
  }
  return parsed.data;
};

const env = parseForecastEnv(process.env);

/**
 * One document client for both adapters: a shared connection pool, and one place
 * the storage failure policy (attempt budget, backoff, request timeout) is set —
 * `@cumulo/storage` owns all three, and building the client here rather than per
 * adapter is what keeps that true.
 */
const documentClient = createStorageDocumentClient();

/**
 * The service's clock, as a dependency rather than a `new Date()` inside the
 * fan-out.
 *
 * Fixed-width to the second, because ADR 0002's range queries rely on
 * lexicographic order being chronological and `toISOString()`'s milliseconds break
 * that. Parsed through the schema rather than asserted, so the normalizing regex
 * and the brand can never disagree.
 */
const now = (): UtcIsoTimestamp =>
  utcIsoTimestampSchema.parse(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

/**
 * The Lambda entry point. `dist/main.mjs` is the bundle and `main.handler` is the
 * function handler string `infra/forecast/lambda.tf` configures.
 *
 * `sites` and `series` are the full adapters; `ConsumeMessageDeps` narrows each to
 * the one method a message may use, so this service's least-privilege posture
 * (ADR 0002: reads `sites`, writes `series`) is a compile-time fact as well as an
 * IAM policy.
 *
 * The adapters are passed as whole objects, never as `adapter.putForecasts`: they
 * hold their client and table name on `this` (#77), so a detached method would
 * arrive at the message path already broken. The narrowing is the type's job —
 * `Pick<…>` costs nothing at runtime and cannot lose a binding.
 */
export const handler: ForecastHandler = createHandler({
  sites: new SiteAdapter({
    client: documentClient,
    tableName: storageTableName('sites', env.CUMULO_ENV),
  }),
  series: new SeriesAdapter({
    client: documentClient,
    tableName: storageTableName('series', env.CUMULO_ENV),
  }),
  log: jsonLineLog,
  now,
});
