import type { Forecast, SitePhysics, UtcIsoTimestamp } from '@cumulo/shared';
import type { BatchWriteOutcome, SeriesRangeResult } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import type { ConsumeMessageDeps } from './consume-message';
import { ISSUED_AT, RATHMINES_ID, reading, recordOf, sitePhysics } from './forecast-fixtures';
import { batchSummaryEvent, createHandler, messageOutcomeEvent } from './handler';

/**
 * The handler is tested through the real `consumeMessage` — the question it
 * answers is "which messages does Lambda have to redeliver?", and that answer is a
 * function of what a record's processing actually did, not of a stub's say-so
 * (`docs/standards/testing.md` rule 1). Only the two adapters are doubles.
 */

interface Recorder {
  readonly written: Forecast[][];
  readonly entries: Record<string, unknown>[];
}

const emptyRecorder = (): Recorder => ({ written: [], entries: [] });

interface HandlerDepsInput {
  readonly recorder: Recorder;
  readonly sites?: readonly SitePhysics[];
  readonly storeOutcome?: BatchWriteOutcome;
}

const handlerDeps = (input: HandlerDepsInput): ConsumeMessageDeps => ({
  sites: {
    listActiveSitePhysicsAtLocation: () => Promise.resolve([...(input.sites ?? [sitePhysics()])]),
  },
  series: {
    putForecasts: (forecasts): Promise<BatchWriteOutcome> => {
      input.recorder.written.push([...forecasts]);
      return Promise.resolve(input.storeOutcome ?? { status: 'complete' });
    },
    // The simulated-actuals producer's two calls (#264), answering with an empty trailing window.
    // The handler's question is which records Lambda must redeliver, and that answer does not
    // depend on the producer — `consume-message.test.ts` is where that independence is proved.
    querySeriesRange: (): Promise<SeriesRangeResult> =>
      Promise.resolve({ points: [], complete: true }),
    putGenerationReadings: (): Promise<BatchWriteOutcome> =>
      Promise.resolve({ status: 'complete' }),
  },
  log: (entry) => {
    input.recorder.entries.push(entry);
  },
  now: (): UtcIsoTimestamp => ISSUED_AT,
});

const badBody = { messageId: 'bad-1', body: 'this is not a weather message' };

const entriesFor = (recorder: Recorder, event: string): Record<string, unknown>[] =>
  recorder.entries.filter((entry) => entry.event === event);

describe('the forecast Lambda handler', () => {
  it('fails only the bad record, and still stores the good one', async () => {
    const recorder = emptyRecorder();
    const handler = createHandler(handlerDeps({ recorder }));

    const response = await handler({
      Records: [
        badBody,
        recordOf('good-1', [reading(), reading({ validTime: '2026-07-31T14:00:00Z' })]),
      ],
    });

    // Exactly the bad message: redriving the good one would silently repeat work
    // that already succeeded, which is what `ReportBatchItemFailures` prevents.
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'bad-1' }]);
    expect(recorder.written).toHaveLength(1);
    expect(recorder.written[0]).toHaveLength(2);
  });

  it('reports no failures at all when every record stores', async () => {
    const recorder = emptyRecorder();
    const handler = createHandler(handlerDeps({ recorder }));

    const response = await handler({
      Records: [recordOf('m-1', [reading()]), recordOf('m-2', [reading()])],
    });

    // An empty array, not an omitted field: Lambda reads `batchItemFailures`, and
    // leaving it out would mean "the whole batch failed".
    expect(response).toEqual({ batchItemFailures: [] });
    expect(recorder.written).toHaveLength(2);
  });

  it('fails a record whose write drained only partially', async () => {
    const recorder = emptyRecorder();
    const handler = createHandler(
      handlerDeps({ recorder, storeOutcome: { status: 'partial', unprocessedCount: 4 } }),
    );

    const response = await handler({ Records: [recordOf('m-1', [reading()])] });

    // `BatchWriteItem` answers HTTP 200 while handing back items it declined, so a
    // partial drain must not count as delivered. Redelivery rewrites the rows that
    // did land, which costs nothing: every write is an idempotent Put.
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm-1' }]);
  });

  it('succeeds with zero writes when the location has no active sites left', async () => {
    const recorder = emptyRecorder();
    const handler = createHandler(handlerDeps({ recorder, sites: [] }));

    const response = await handler({ Records: [recordOf('m-1', [reading()])] });

    expect(response.batchItemFailures).toEqual([]);
    expect(recorder.written).toEqual([]);
  });

  it('throws on an event that is not an SQS event, rather than reporting an outcome', async () => {
    const handler = createHandler(handlerDeps({ recorder: emptyRecorder() }));

    // A malformed event is a platform bug: there are no message ids to report, and
    // the throw is what moves the `Errors` metric the forecast alarm watches.
    await expect(handler({ Message: 'not an SQS event' })).rejects.toThrow(
      'unrecognised SQS event',
    );
  });

  it('throws on an event whose record is missing a message id', async () => {
    const handler = createHandler(handlerDeps({ recorder: emptyRecorder() }));

    await expect(handler({ Records: [{ body: '[]' }] })).rejects.toThrow('unrecognised SQS event');
  });

  it('logs one outcome per record and one summary, in that order', async () => {
    const recorder = emptyRecorder();
    const handler = createHandler(handlerDeps({ recorder }));

    await handler({ Records: [recordOf('m-1', [reading()]), badBody] });

    expect(entriesFor(recorder, messageOutcomeEvent)).toHaveLength(2);
    expect(entriesFor(recorder, batchSummaryEvent)).toEqual([
      { event: batchSummaryEvent, records: 2, stored: 1, failed: 1 },
    ]);
    // The summary is last: a failed batch must still leave behind the full account
    // of which messages worked.
    expect(recorder.entries.at(-1)?.event).toBe(batchSummaryEvent);
  });

  it('carries each outcome’s own fields into its log entry', async () => {
    const recorder = emptyRecorder();
    const handler = createHandler(
      handlerDeps({ recorder, sites: [sitePhysics(), sitePhysics({ id: RATHMINES_ID })] }),
    );

    await handler({ Records: [recordOf('m-1', [reading()])] });

    expect(entriesFor(recorder, messageOutcomeEvent)).toEqual([
      {
        event: messageOutcomeEvent,
        messageId: 'm-1',
        status: 'stored',
        siteCount: 2,
        forecastCount: 2,
      },
    ]);
  });

  it('summarises an empty batch rather than returning silently', async () => {
    const recorder = emptyRecorder();
    const handler = createHandler(handlerDeps({ recorder }));

    const response = await handler({ Records: [] });

    expect(response).toEqual({ batchItemFailures: [] });
    expect(entriesFor(recorder, batchSummaryEvent)).toEqual([
      { event: batchSummaryEvent, records: 0, stored: 0, failed: 0 },
    ]);
  });

  it('processes a multi-record batch sequentially, in the order delivered', async () => {
    const recorder = emptyRecorder();
    const handler = createHandler(handlerDeps({ recorder }));

    await handler({
      Records: [
        recordOf('m-1', [reading({ validTime: '2026-07-31T11:00:00Z' })]),
        recordOf('m-2', [reading({ validTime: '2026-07-31T12:00:00Z' })]),
        recordOf('m-3', [reading({ validTime: '2026-07-31T13:00:00Z' })]),
      ],
    });

    expect(entriesFor(recorder, messageOutcomeEvent).map((entry) => entry.messageId)).toEqual([
      'm-1',
      'm-2',
      'm-3',
    ]);
  });
});
