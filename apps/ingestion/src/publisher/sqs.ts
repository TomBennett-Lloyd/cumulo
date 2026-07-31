import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { weatherReadingSchema } from '@cumulo/shared';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { z } from 'zod';

import type { ForecastWeatherReading } from '../open-meteo/response';
import type { WeatherPublisher } from './weather-publisher';

/**
 * The SQS implementation of the transport seam (ADR 0004): one `SendMessage` per
 * location per cycle, carrying that location's whole horizon.
 *
 * Two things happen here and nowhere else. The first is the **payload contract**:
 * a message body is `@cumulo/shared`'s weather reading schema, parsed rather than
 * asserted, so the bytes on the queue are exactly the fields the shared schema
 * defines — no more (zod strips what it does not know about) and no less. The
 * forecast service (#12) parses the same schema on the way in, which is what makes
 * "the wire format" a single definition instead of two that currently agree
 * (`docs/standards/architecture.md` rule 2). Provenance is not a message attribute
 * or a queue convention: it is the readings' own `source` field, so a payload that
 * has been separated from its envelope still says where it came from.
 *
 * The second is the **failure policy**, stated here rather than inherited from SDK
 * defaults (`docs/standards/error-handling.md` rule 3, and ADR 0004's "What #11
 * owns"). See {@link createIngestionSqsClient}.
 *
 * What deliberately does *not* happen here is error wrapping. A send that fails is
 * an outage of the transport, not an outcome of this seam's domain, so it
 * propagates untouched (rule 1) to `cycle.ts`, which is the boundary that adds the
 * context: the operation that threw and the location it was for. Rewrapping would
 * replace the SDK's own error name — `QueueDoesNotExist`, `AccessDenied`,
 * `TimeoutError`, each pointing at a different fix — with a generic one in the very
 * log line an operator reads.
 */

/**
 * The message body's schema: an array of shared weather readings.
 *
 * Exported because it is a contract, not an implementation detail — #12's consumer
 * parses the same array on the way out of the queue, and a test that asserts a
 * published body against anything else is asserting a copy.
 */
export const weatherMessageSchema = z.array(weatherReadingSchema);

/**
 * Total attempts per `SendMessage`, initial send included — so two retries.
 *
 * Pinned for the same reason `@cumulo/storage` pins its own: the SDK's attempt
 * count is otherwise environment-dependent (`AWS_MAX_ATTEMPTS`, the shared config
 * file, and the 2026 retry defaults), and a Lambda that retries a different number
 * of times than a developer's laptop is a failure nobody can reproduce. The number
 * is small on purpose — the real retry for a failed publish is the next hourly
 * cycle, which re-fetches and re-publishes the same idempotent horizon, and a
 * location that cannot be published is already reported as a failed cycle.
 *
 * Unlike storage, the *delay curve* is left to the standard strategy. Storage
 * pinned its backoff because provisioned-capacity throttling is its expected
 * retryable failure and the throttling base is environment-dependent; at twelve
 * sends an hour against a service with no provisioned capacity, throttling is not
 * a failure mode this queue has, so there is nothing here for a pinned curve to
 * protect.
 */
export const INGESTION_SEND_MAX_ATTEMPTS = 3;

/**
 * Per-attempt deadline, in milliseconds. The SDK's default is **0 — no timeout at
 * all**, which in a Lambda means one stalled socket silently consumes the whole
 * invocation and the eleven other locations never get their turn.
 *
 * 3 s is roughly thirty times a healthy regional `SendMessage`. With
 * {@link INGESTION_SEND_MAX_ATTEMPTS} it bounds one location's publish at ~9 s
 * plus backoff, so the canonical twelve-location cycle's publishing is bounded at
 * roughly two minutes even if the queue is entirely unreachable — the figure the
 * function timeout in ingestion's Terraform has to clear.
 */
export const INGESTION_SEND_REQUEST_TIMEOUT_MS = 3_000;

/** Connection-establishment deadline, in milliseconds: a DNS or TCP stall is not a slow queue. */
export const INGESTION_SEND_CONNECTION_TIMEOUT_MS = 1_000;

/**
 * The SQS client ingestion publishes through, with its failure policy fixed at
 * construction.
 *
 * The region is deliberately absent: Lambda always sets `AWS_REGION`, and naming it
 * a second time in this service's environment would be one more place for the queue
 * and the client to disagree about which region the queue is in.
 */
export const createIngestionSqsClient = (): SQSClient =>
  new SQSClient({
    maxAttempts: INGESTION_SEND_MAX_ATTEMPTS,
    requestHandler: new NodeHttpHandler({
      requestTimeout: INGESTION_SEND_REQUEST_TIMEOUT_MS,
      connectionTimeout: INGESTION_SEND_CONNECTION_TIMEOUT_MS,
      // Load-bearing, and it was missing until #115 measured it: in the
      // installed @smithy/node-http-handler 4.9.13, `requestTimeout` alone
      // only logs a warning and lets the socket hang — the destroy-and-reject
      // branch is gated on this flag. The comment above claimed a bound of
      // ~9 s per location that the code did not actually enforce, and
      // `cycle-budget.ts` now imports these numbers as arithmetic.
      throwOnRequestTimeout: true,
    }),
  });

export interface SqsWeatherPublisherDeps {
  readonly client: SQSClient;
  /**
   * The full queue URL of `cumulo-weather-readings-<env>` (ADR 0004, and
   * `infra/ingestion/transport.tf`), e.g.
   * `https://sqs.<region>.amazonaws.com/<account>/cumulo-weather-readings-<env>`.
   */
  readonly queueUrl: string;
}

/**
 * A {@link WeatherPublisher} that sends one message per location to an SQS queue.
 *
 * A class rather than a function because there is state to hold — the client and
 * the queue URL are fixed for the life of the Lambda container and shared by every
 * publish — and because `implements WeatherPublisher` makes the compiler check the
 * seam rather than a reviewer.
 */
export class SqsWeatherPublisher implements WeatherPublisher {
  readonly #client: SQSClient;
  readonly #queueUrl: string;

  constructor(deps: SqsWeatherPublisherDeps) {
    this.#client = deps.client;
    this.#queueUrl = deps.queueUrl;
  }

  /**
   * Validate, then send. In that order, and the order is the point: a reading the
   * shared schema rejects means this service's normalization is wrong, and the
   * queue is the last place to discover that — #12 would either reject the whole
   * batch or, worse, act on a value outside the domain's physical bounds. So the
   * parse throws before anything reaches the wire, and the location is reported
   * as failed by `cycle.ts` with the readings still safely in `cumulo-weather`.
   *
   * A cycle's payload is ~15–20 KB (48 hours × ten-odd numeric fields), comfortably
   * inside SQS's 256 KB message limit; ADR 0004 records the horizon growth that
   * would change that.
   */
  async publishLocationReadings(readings: readonly ForecastWeatherReading[]): Promise<void> {
    if (readings.length === 0) {
      // Not a domain outcome: `parseForecastResponse` reports an all-unusable
      // response as `malformed` and `cycle.ts` never publishes one, so an empty
      // batch here is a bug upstream (rule 1). Sending it would wake #12 with a
      // message that says nothing — the kind of no-op that looks like success.
      throw new Error('SqsWeatherPublisher: refusing to publish a location with no readings');
    }

    const body = JSON.stringify(weatherMessageSchema.parse(readings));

    await this.#client.send(
      new SendMessageCommand({ QueueUrl: this.#queueUrl, MessageBody: body }),
    );
  }
}
