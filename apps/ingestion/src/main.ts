import {
  createSiteAdapter,
  createStorageDocumentClient,
  createWeatherAdapter,
  storageTableName,
} from '@cumulo/storage';
import { z } from 'zod';

import { createHandler, jsonLineLog, type IngestionHandler } from './handler';
import { fetchForecast, type ForecastFetchDeps } from './open-meteo/fetch-forecast';
import { SqsWeatherPublisher, createIngestionSqsClient } from './publisher/sqs';
import { describeZodIssues } from './zod-issue-detail';

/**
 * The composition root, and the module the bundled artifact's `handler` export
 * comes from.
 *
 * Everything that is a *decision* about the running system lives here and only
 * here: which tables, which queue, which log sink, which clients. Every module
 * beneath takes its collaborators as parameters, which is what lets the whole
 * cycle — including its failure paths — run in a unit test with no AWS in sight
 * (`docs/standards/architecture.md` rule 3).
 *
 * The composition happens at **module scope**, on purpose. AWS reuses a warm
 * container across invocations, so clients built here are built once per container
 * rather than once per cycle — and, more importantly, a missing or malformed
 * environment variable fails the *initialization*, before any cycle claims to have
 * run. A service that only discovers its queue URL is nonsense on the first send
 * has already fetched, stored, and told its operator nothing.
 */

/**
 * The environment this service requires, as the only place `process.env` is read
 * (`docs/standards/typing.md` rule 3 — external data is `unknown` until parsed).
 *
 * `AWS_REGION` is deliberately absent: Lambda always sets it and the SDK reads it
 * directly, so restating it here would create a second dial that can disagree with
 * the region the queue and tables actually live in.
 *
 * `CUMULO_ENV` is checked only for being non-empty. The alphabet a real environment
 * name has to satisfy is `storageTableName`'s, which mirrors
 * `infra/storage/variables.tf`; restating the pattern here would make three copies
 * of it, and `storageTableName` throws at this same startup with a message naming
 * the offending value.
 */
export const ingestionEnvSchema = z.object({
  CUMULO_ENV: z.string().min(1),
  QUEUE_URL: z.url(),
});

export type IngestionEnv = z.infer<typeof ingestionEnvSchema>;

/**
 * Parse the process environment, or fail loudly.
 *
 * A throw rather than a value (`docs/standards/error-handling.md` rule 1): a
 * missing queue URL is a deployment that is wrong, not an outcome an ingestion
 * cycle could handle. The message names every offending variable at once, because
 * a deployment with two missing variables should take one fix, not two.
 */
export const parseIngestionEnv = (source: Record<string, string | undefined>): IngestionEnv => {
  const parsed = ingestionEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`ingestion: invalid environment — ${describeZodIssues(parsed.error)}`);
  }
  return parsed.data;
};

const env = parseIngestionEnv(process.env);

/**
 * One document client for both adapters: a shared connection pool, and one place
 * the storage failure policy (attempt budget, backoff) is set — `@cumulo/storage`
 * owns both, and building the client here rather than per adapter is what keeps
 * that true.
 */
const documentClient = createStorageDocumentClient();

/**
 * Ingestion runs Open-Meteo on the adapter's own timeout, retry and jitter — an
 * hourly batch against a free tier is exactly the shape those defaults were argued
 * for. Stated as an empty override rather than left implicit at the call site,
 * because "this service overrides nothing" is a decision the composition root owns
 * and the next reader will want to see made.
 */
const openMeteoPolicy: ForecastFetchDeps = {};

/**
 * The Lambda entry point. `dist/main.mjs` is the bundle and `main.handler` is the
 * function handler string ingestion's Terraform configures.
 *
 * `sites` and `weather` are the full adapters; `RunCycleDeps` narrows each to the
 * one method the cycle may use, so ingestion's least-privilege posture (ADR 0002:
 * reads `sites`, writes `weather`) is a compile-time fact as well as an IAM policy.
 */
export const handler: IngestionHandler = createHandler({
  sites: createSiteAdapter({
    client: documentClient,
    tableName: storageTableName('sites', env.CUMULO_ENV),
  }),
  weather: createWeatherAdapter({
    client: documentClient,
    tableName: storageTableName('weather', env.CUMULO_ENV),
  }),
  publisher: new SqsWeatherPublisher({
    client: createIngestionSqsClient(),
    queueUrl: env.QUEUE_URL,
  }),
  // The adapter is a function of (policy, location); the cycle's dependency is the
  // call for one location. Binding the policy here is the whole of that difference,
  // and it is the composition root's job rather than the cycle's.
  fetchForecast: (location) => fetchForecast(openMeteoPolicy, location),
  log: jsonLineLog,
});
