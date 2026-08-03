import { describeZodIssues } from '@cumulo/shared';

import { consumeMessage, type ConsumeMessageDeps, type MessageOutcome } from './consume-message';
import { sqsEventSchema, type SqsBatchResponse } from './sqs-event';

/**
 * The Lambda entry point: a batch of queue messages in, the ids of the ones that
 * failed out.
 *
 * Two boundaries meet here and they fail differently. A malformed **event** is a
 * platform bug — SQS did not send us an SQS event — and throws, because there is
 * no message to attribute it to and no retry that helps. A malformed **message**
 * is one record's outcome, reported through `batchItemFailures`. Collapsing the
 * two would either swallow a broken deployment or dead-letter the platform.
 *
 * ## Budget posture: SQS owns retry, so this service builds no deadline
 *
 * Ingestion (#115) carries a deadline, a location cap and a whole `cycle-budget.ts`
 * of arithmetic, because a cycle killed at its timeout loses the only record of
 * what it did: the fleet's work is spread over one invocation, nothing else knows
 * what was attempted, and there is no retry. **None of those premises hold here**,
 * and the difference is the design rather than an omission:
 *
 * - The unit of work is one message, and the queue still holds it. An invocation
 *   killed at the 50 s function timeout (`infra/forecast/lambda.tf`) simply does
 *   not delete its message: after the 300 s visibility timeout
 *   (`infra/ingestion/transport.tf`, six times the function timeout as ADR 0004
 *   requires) it is redelivered, up to `maxReceiveCount = 5`, and then lands in
 *   `cumulo-weather-readings-dlq-<env>` — which is alarmed. So the retry and the
 *   operator signal both already exist, in infrastructure, and a deadline here
 *   would be a second mechanism competing with them.
 * - Every write is idempotent by construction: a Put over the sort key
 *   `T#<validTime>#FC#physics` (ADR 0002), so a redelivered message rewrites
 *   exactly the rows it wrote before. Retrying costs duplicate work and nothing
 *   else.
 * - There is no external quota to protect. This service makes **zero** Open-Meteo
 *   calls; its weather arrives on the queue. CLAUDE.md's frugality constraint is
 *   ingestion's to honour, and this service adds no term to it.
 *
 * ### The arithmetic, on the constants actually in the tree
 *
 * Healthy, for a canonical five-site location: one `by-location` GSI query, 5 × 48
 * = 240 pure physics evaluations, and `ceil(240 / DYNAMODB_BATCH_WRITE_SIZE)` = 10
 * `BatchWriteItem` pages. That is 11 same-region DynamoDB round trips of a few tens
 * of milliseconds each — well under a second of work, and 1–2 s including a cold
 * start. Against 50 s, roughly an order of magnitude of headroom.
 *
 * Pathological, on the post-#122 storage constants (`STORAGE_MAX_ATTEMPTS` 2,
 * `STORAGE_REQUEST_TIMEOUT_MS` 3 s, `STORAGE_RETRY_BASE_DELAY_MS` 1 s, and
 * `defaultBatchPolicy` at 3 attempts / 200 ms): one send's worst case is
 * `2 × 3 s + 1 s` = **7 s**, and one page's drain is at most three sends plus its
 * own backoff — `3 × 7 s + 0.6 s` ≈ **21.6 s**, six round trips (3 drain × 2 SDK).
 * Ten pages is ≈ **216 s**, and the site query adds ≈ 7 s: ≈ **223 s**, more than
 * four times the function timeout.
 *
 * ### Which failure actually produces that number — and which does not
 *
 * It is worth being exact, because the obvious guess is wrong. A **DynamoDB
 * outage does not grind**: `drainBatches` re-sends only what a *successful*
 * response reported as `UnprocessedItems`, and a rejection from a send propagates
 * out of the drain untouched (`packages/storage/src/batch.ts`). So an outage
 * rejects on page 1 after that page's ≈ 7 s of SDK attempts, and with the site
 * query ahead of it the record is `failed` at ≈ 14 s — comfortably inside the
 * timeout, with its outcome entry and the batch summary both written.
 *
 * The ≈ 216 s grind needs the opposite of an outage, and specifically a **mixed**
 * regime rather than a purely declining one: each send's first attempt timing out,
 * and its one SDK retry then answering HTTP 200 with all but one of its 25 items
 * unprocessed. (All but one, not all: a *wholly* declined batch does not answer
 * 200 at all — DynamoDB rejects it with `ProvisionedThroughputExceededException`,
 * which the drain cannot retry, so it takes the outage path priced above;
 * `packages/storage/src/client.ts` states that boundary.) That is what the 7 s
 * per-send term actually prices — `2 × 3 s + 1 s` spends two attempts only when
 * the first failed *retryably*, which a 200 never is.
 *
 * A **pure** 200-declining regime is therefore cheaper per send, not dearer: one
 * HTTP attempt bounded at 3 s to headers, so ≈ 9.6 s per page (`3 × 3 s + 0.6 s`)
 * and ≈ 96 s over ten. Both regimes are sustained throttling — `cumulo-series` is
 * a provisioned table (ADR 0002; `infra/storage/tables.tf` owns the figure), and a
 * hot enough write burst is how a table both slows down and declines items — and
 * both blow the 50 s timeout, so nothing below depends on which of the two you
 * actually get. The mapping's `maximum_concurrency = 2` exists to keep the
 * fleet's writes out of either.
 *
 * Only in *those* cases can an invocation reach the 50 s timeout, and only there is
 * the consequence worth naming: a killed invocation's logs stop mid-batch, so
 * `forecast.batch.summary` is absent rather than reporting failures. The absence
 * is still diagnosable — `cumulo-forecast-<env>-errors` fires on the
 * invocation-level failure, which is what `infra/forecast/alarms.tf` exists for,
 * and the storage stack's own throttle alarm is lit at the same moment — but it is
 * an absence, and a reader of these logs should know that. Ingestion had to build a
 * deadline precisely because for it the lost report *was* the only signal; here the
 * message is still on the queue, and after five receives the DLQ alarm says so.
 */

/** Emitted once per record, whatever became of it. */
export const messageOutcomeEvent = 'forecast.message.outcome';

/** Emitted once per invocation, after every record's own entry. */
export const batchSummaryEvent = 'forecast.batch.summary';

/**
 * The handler's signature. The event is `unknown` rather than a typed payload:
 * it is external data, and naming a type for it here would be the hand-written
 * duplicate of `sqsEventSchema` that `docs/standards/typing.md` rule 3 forbids.
 */
export type ForecastHandler = (event: unknown) => Promise<SqsBatchResponse>;

/**
 * The production log sink: one JSON object per line, which is what makes
 * CloudWatch Logs Insights able to query these entries by field instead of by
 * substring. `console.log` is correct *here* and nowhere else — this module is the
 * process boundary that `docs/standards/error-handling.md` rule 4 reserves it for,
 * and every module beneath it takes `log` as a dependency.
 */
export const jsonLineLog = (entry: Record<string, unknown>): void => {
  console.log(JSON.stringify(entry));
};

/**
 * Whether a record's outcome must be reported back to Lambda as a batch item
 * failure.
 *
 * Stated as "not one of the two successes" rather than as a list of the three
 * failures, so a sixth outcome added later fails the record until someone decides
 * otherwise. Defaulting a new state to "retry it" is recoverable; defaulting it to
 * "silently drop it" is the swallowed failure `docs/standards/error-handling.md`
 * rule 2 exists to prevent.
 */
const failsTheRecord = (outcome: MessageOutcome): boolean =>
  outcome.status !== 'stored' && outcome.status !== 'no-active-sites';

/**
 * Bind the message-processing dependencies into the handler AWS invokes.
 *
 * Records are processed **sequentially**. At `batch_size = 1`
 * (`infra/forecast/event-source.tf`) there is nothing to parallelise today, and at
 * a larger size a serial loop is still the right shape: the writes all land on
 * `cumulo-series`' provisioned write capacity, so concurrency inside an invocation
 * would fight the very throttling the mapping's `maximum_concurrency = 2` exists to
 * avoid.
 *
 * Every outcome is logged before the summary, and the summary is emitted even for
 * an empty batch — a handler that returned silently would be indistinguishable
 * from one that never ran.
 */
export const createHandler =
  (deps: ConsumeMessageDeps): ForecastHandler =>
  async (event: unknown): Promise<SqsBatchResponse> => {
    const parsed = sqsEventSchema.safeParse(event);
    if (!parsed.success) {
      // A throw, not an outcome (`docs/standards/error-handling.md` rule 1): this
      // is a violated invariant of the platform contract, and it moves the
      // function's `Errors` metric, which is what `infra/forecast/alarms.tf`
      // watches. Reporting it as a batch item failure is not even possible —
      // there are no message ids to report.
      throw new Error(`forecast: unrecognised SQS event — ${describeZodIssues(parsed.error)}`);
    }

    const { Records } = parsed.data;

    const outcomes: MessageOutcome[] = [];
    for (const record of Records) {
      const outcome = await consumeMessage(deps, record);
      deps.log({ event: messageOutcomeEvent, ...outcome });
      outcomes.push(outcome);
    }

    const failures = outcomes
      .filter(failsTheRecord)
      .map((outcome) => ({ itemIdentifier: outcome.messageId }));

    deps.log({
      event: batchSummaryEvent,
      records: Records.length,
      stored: outcomes.filter((outcome) => outcome.status === 'stored').length,
      failed: failures.length,
    });

    return { batchItemFailures: failures };
  };
