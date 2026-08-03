import {
  describeThrown,
  describeZodIssues,
  locationId,
  weatherMessageSchema,
  type ForecastWeatherReading,
  type SitePhysics,
  type UtcIsoTimestamp,
} from '@cumulo/shared';
import type { BatchWriteOutcome, SeriesAdapter, SiteAdapter } from '@cumulo/storage';

import { locationForecasts, type LocationForecastsOutcome } from './location-forecasts';
import type { SqsRecord } from './sqs-event';

/**
 * One queue message, from `body` to written rows — and never throwing.
 *
 * This module is the record boundary. Everything above it (`handler.ts`) decides
 * what a batch reports to Lambda; everything below it is pure. So this is where
 * an `unknown` thrown by anything beneath it — an adapter, or a bug in the
 * physics chain — becomes a value the batch can count
 * (`docs/standards/error-handling.md` rule 2a), and where the fan-out's own
 * `implausible-hour` value becomes a `failed` record. A `consumeMessage` that
 * threw would abandon the rest of its batch — today a batch of one, but the
 * mapping's `batch_size` is a number, not a contract.
 *
 * There is no separate "already processed?" check, and there is deliberately no
 * place to put one: SQS is at-least-once, and idempotency here is *structural*.
 * Every row is a Put over the sort key `T#<validTime>#FC#physics` (ADR 0002), so
 * a redelivered message rewrites exactly the rows it wrote the first time. That
 * property is what makes the rest of this module's failure policy — fail the
 * record, let the queue redeliver — free rather than merely acceptable.
 */

/**
 * What became of one message, as a value.
 *
 * The five cases split three ways for the caller, and that split is the reason
 * they are five rather than a boolean:
 *
 * - `stored` is the success, with the shape of the work it did.
 * - `no-active-sites` is **also** a success, and the distinction matters: a
 *   location whose sites were all deactivated between publish and delivery has
 *   nothing to forecast, and redelivering that message forever would turn an
 *   ordinary fleet edit into a DLQ entry.
 * - `malformed`, `store-partial` and `failed` each fail the record. They are kept
 *   apart because the operator's next step differs: a malformed body means the
 *   ingestion→forecast contract moved and no retry will help (the message is
 *   destined for the DLQ, which is the correct place for it); `store-partial`
 *   means DynamoDB declined writes and the next delivery will likely succeed; and
 *   `failed` names either the operation that threw or the site-hour whose physics
 *   was implausible.
 */
export type MessageOutcome = { readonly messageId: string } & (
  | { readonly status: 'stored'; readonly siteCount: number; readonly forecastCount: number }
  | { readonly status: 'no-active-sites' }
  | { readonly status: 'malformed'; readonly detail: string }
  | { readonly status: 'store-partial'; readonly unprocessedCount: number }
  | { readonly status: 'failed'; readonly detail: string }
);

/**
 * The collaborators one message's processing needs.
 *
 * The adapters are narrowed to one method each, so this service's least-privilege
 * posture — reads `sites`, writes `series`, touches nothing else (ADR 0002) — is a
 * compile-time fact as well as an IAM policy. They are passed as whole objects and
 * never as `adapter.putForecasts`: the adapters hold their client and table name
 * on `this`, so a detached method would arrive already broken
 * (`docs/standards/structure.md` rule 3).
 *
 * `log` is declared here rather than only on the handler because this is the type
 * the handler binds once and hands down; `consumeMessage` itself logs nothing, on
 * purpose — it returns its outcome and the boundary decides what to say about it.
 */
export interface ConsumeMessageDeps {
  readonly sites: Pick<SiteAdapter, 'listActiveSitePhysicsAtLocation'>;
  readonly series: Pick<SeriesAdapter, 'putForecasts'>;
  /**
   * Structured-logging sink (`docs/standards/error-handling.md` rule 4). Injected
   * rather than reached for, so no module below the composition root holds a
   * console and the tests read the entries a reviewer would read in CloudWatch.
   */
  readonly log: (entry: Record<string, unknown>) => void;
  /**
   * The forecast vintage clock. Injected because `issuedAt` is the one input to
   * an otherwise pure fan-out that depends on when the code ran, and a row whose
   * vintage a test cannot pin is a row a test cannot assert on.
   */
  readonly now: () => UtcIsoTimestamp;
}

/**
 * The three calls in a message's processing that can throw. A `failed` outcome
 * must say which of them did, because the next step differs
 * (`docs/standards/error-handling.md` rule 4): a `listActiveSitePhysicsAtLocation`
 * throw is the sites table or its index, a `putForecasts` throw is the series
 * table, and a `locationForecasts` throw is a bug in the physics chain — nothing
 * an operator can fix in AWS.
 *
 * The fan-out is on this list even though it is pure and synchronous, because it
 * is total over *implausibility* only, not over bugs. A physically implausible
 * hour comes back as a value, which this module renders into a `failed` outcome
 * naming the site and the hour rather than an operation that threw — but any
 * other way the chain beneath it can end is still a throw, and it must not leave
 * this module: `handler.ts` does not catch, so an escaping throw would fail the
 * whole invocation and abandon the record's batch-mates, losing the per-record
 * redrive (#136) for exactly the case an operator most needs isolated.
 */
type MessageOperation = 'listActiveSitePhysicsAtLocation' | 'locationForecasts' | 'putForecasts';

const failedOutcome = (
  messageId: string,
  operation: MessageOperation,
  error: unknown,
): MessageOutcome => ({
  messageId,
  status: 'failed',
  detail: `${operation} threw — ${describeThrown(error)}`,
});

const malformedOutcome = (messageId: string, detail: string): MessageOutcome => ({
  messageId,
  status: 'malformed',
  detail,
});

/**
 * A message body, as either the horizon it carries or the reason it is not one.
 *
 * Two failure modes, one vocabulary: a body that is not JSON and a body that is
 * JSON of the wrong shape are the same thing to an operator — the contract in
 * `@cumulo/shared`'s `weatherMessageSchema` was not honoured — and both are
 * hopeless to retry.
 */
type ParsedBody =
  | { readonly status: 'readings'; readonly readings: readonly ForecastWeatherReading[] }
  | { readonly status: 'malformed'; readonly detail: string };

const parseBody = (body: string): ParsedBody => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error: unknown) {
    // The one `catch` here that is not about an effect: `JSON.parse` throws for a
    // body that is not JSON at all, which is a *parse outcome* rather than a bug,
    // so it is converted rather than propagated (rule 2a).
    return { status: 'malformed', detail: `body is not JSON — ${describeThrown(error)}` };
  }

  const parsed = weatherMessageSchema.safeParse(json);
  if (!parsed.success) {
    return {
      status: 'malformed',
      detail: `body is not a weather message — ${describeZodIssues(parsed.error)}`,
    };
  }

  return { status: 'readings', readings: parsed.data };
};

/**
 * The one location a message speaks for, or `undefined` if it does not name
 * exactly one.
 *
 * ADR 0004 makes a message *one location's* whole horizon, so a body carrying two
 * is a violated contract rather than a case to handle: fanning it out would run
 * one location's weather against another location's sites and store the result as
 * a forecast. Refusing it is the only honest option.
 *
 * The zero case is unreachable from a parsed body — `weatherMessageSchema` is
 * `.min(1)` — so the emptiness half of the guard below is the compiler's
 * obligation rather than a branch a mutation could expose. It is written as one
 * condition with the multi-location half because both say the same thing: this
 * message does not name exactly one location.
 */
const singleLocationId = (readings: readonly ForecastWeatherReading[]): string | undefined => {
  const ids = [...new Set(readings.map((reading) => locationId(reading)))];
  const [only] = ids;
  return only === undefined || ids.length > 1 ? undefined : only;
};

/**
 * Process one record: parse, look up the location's active sites, forecast, write.
 *
 * The order is forced rather than chosen. The location is derived from the
 * readings, so it cannot precede the parse; the sites are keyed by that location;
 * the vintage is read once, after the sites are known, so that every row of one
 * message shares an `issuedAt` and the whole message is one identifiable forecast
 * run.
 *
 * Each fallible step converts its own failure where it happens, so what went
 * wrong survives into the log line — the operation for a throw, the site and
 * hour for an implausible one. That is the difference between an entry an
 * operator can act on and "message X failed", which costs an hour.
 */
export const consumeMessage = async (
  deps: ConsumeMessageDeps,
  record: SqsRecord,
): Promise<MessageOutcome> => {
  const { messageId } = record;

  const body = parseBody(record.body);
  if (body.status === 'malformed') {
    return malformedOutcome(messageId, body.detail);
  }

  const location = singleLocationId(body.readings);
  if (location === undefined) {
    return malformedOutcome(
      messageId,
      'body does not carry exactly one location — ADR 0004 publishes one message per location',
    );
  }

  let sites: SitePhysics[];
  try {
    sites = await deps.sites.listActiveSitePhysicsAtLocation(location);
  } catch (error: unknown) {
    return failedOutcome(messageId, 'listActiveSitePhysicsAtLocation', error);
  }

  if (sites.length === 0) {
    // A success, not a failure. Ingestion publishes for the locations that had
    // active sites when the cycle ran; a site deactivated in the seconds since is
    // ordinary, and nothing about it is worth a redelivery.
    return { messageId, status: 'no-active-sites' };
  }

  let fanOut: LocationForecastsOutcome;
  try {
    fanOut = locationForecasts({ sites, readings: body.readings, issuedAt: deps.now() });
  } catch (error: unknown) {
    // The bug arm. `locationForecasts` answers an implausible hour with a value
    // (handled just below), so anything that reaches here is a violated invariant
    // in the physics chain rather than a domain outcome. It is converted rather
    // than propagated for one reason only: this is the record boundary, and a
    // throw crossing it would take the batch down with the record (rule 2a and
    // rule 1's process-boundary corollary). The record still fails, so the
    // queue's redrive and the alarmed DLQ report it — with `detail` naming the
    // operation, which is how an operator tells a physics bug from a table.
    return failedOutcome(messageId, 'locationForecasts', error);
  }

  if (fanOut.status === 'implausible-hour') {
    // A weather hour that every schema accepts and no atmosphere produces: the
    // physics landed outside `forecastSchema`'s bounds. This service's policy is
    // to fail the record — the queue's redrive (five receives, then the alarmed
    // DLQ) is both the retry and the operator signal (#136) — and the detail names
    // the site and the hour, because that pair is what an operator reading the DLQ
    // has to look up. The blast radius is one location's message, not the batch.
    return {
      messageId,
      status: 'failed',
      detail:
        `implausible physics for site ${fanOut.siteId} at ${fanOut.validTime} — ` + fanOut.detail,
    };
  }

  const { forecasts } = fanOut;

  let stored: BatchWriteOutcome;
  try {
    stored = await deps.series.putForecasts(forecasts);
  } catch (error: unknown) {
    return failedOutcome(messageId, 'putForecasts', error);
  }

  if (stored.status === 'partial') {
    // `BatchWriteItem` answers HTTP 200 while handing back items it declined, so
    // "the call succeeded" and "the data was written" are different facts (ADR
    // 0002 Consequence 4). Failing the record redelivers the whole message, which
    // rewrites the rows that did land — free, because every write is an idempotent
    // Put over a deterministic key.
    return { messageId, status: 'store-partial', unprocessedCount: stored.unprocessedCount };
  }

  return {
    messageId,
    status: 'stored',
    siteCount: sites.length,
    forecastCount: forecasts.length,
  };
};
