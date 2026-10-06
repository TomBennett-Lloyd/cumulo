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
 * See `apps/forecast/README.md`, `## No deadline, and why`.
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
 * The production log sink: one JSON object per line. `console.log` is correct
 * *here* and nowhere else — this module is the process boundary that
 * `docs/standards/error-handling.md` rule 4 reserves it for.
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
 * an empty batch.
 */
export const createHandler =
  (deps: ConsumeMessageDeps): ForecastHandler =>
  async (event: unknown): Promise<SqsBatchResponse> => {
    const parsed = sqsEventSchema.safeParse(event);
    if (!parsed.success) {
      // A throw, not an outcome (`docs/standards/error-handling.md` rule 1): this
      // is a violated invariant of the platform contract, and it moves the
      // function's `Errors` metric, which is what `infra/forecast/alarms.tf`
      // watches.
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
