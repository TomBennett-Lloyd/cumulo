import type { Forecast, SitePhysics, UtcIsoTimestamp } from '@cumulo/shared';
import { StorageError } from '@cumulo/storage';
import type { BatchWriteOutcome } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { consumeMessage, type ConsumeMessageDeps, type MessageOutcome } from './consume-message';
import {
  ISSUED_AT,
  RANELAGH_ID,
  RATHMINES_ID,
  reading,
  recordOf,
  rejectedWith,
  sitePhysics,
} from './forecast-fixtures';

/**
 * One record's processing, exercised through its only public surface: give it a
 * record and two adapter doubles, and read the outcome it returns.
 *
 * The doubles are deliberately thin — they answer or they reject — because the
 * behaviour under test is the *conversion*: which adapter answer becomes which
 * outcome, and which throw becomes which `failed` detail. Anything that mocked an
 * AWS client and asserted the mock was called would prove nothing
 * (`docs/standards/testing.md` rule 3).
 */

/** What the doubles saw, so a test can assert on writes without a spy framework. */
interface Recorder {
  readonly written: Forecast[][];
  readonly locationsQueried: string[];
  readonly entries: Record<string, unknown>[];
}

const emptyRecorder = (): Recorder => ({ written: [], locationsQueried: [], entries: [] });

interface DepsInput {
  readonly recorder: Recorder;
  /** What the sites lookup answers with; defaults to one Ranelagh site. */
  readonly sites?: readonly SitePhysics[];
  /** Rejected by the sites lookup instead of answering. */
  readonly sitesRejectsWith?: unknown;
  /** What the series write answers with; defaults to a complete drain. */
  readonly storeOutcome?: BatchWriteOutcome;
  /** Rejected by the series write instead of answering. */
  readonly storeRejectsWith?: unknown;
  readonly now?: () => UtcIsoTimestamp;
}

const deps = (input: DepsInput): ConsumeMessageDeps => ({
  sites: {
    listActiveSitePhysicsAtLocation: (locationId: string): Promise<SitePhysics[]> => {
      input.recorder.locationsQueried.push(locationId);
      return input.sitesRejectsWith === undefined
        ? Promise.resolve([...(input.sites ?? [sitePhysics()])])
        : rejectedWith(input.sitesRejectsWith);
    },
  },
  series: {
    putForecasts: (forecasts): Promise<BatchWriteOutcome> => {
      if (input.storeRejectsWith !== undefined) {
        return rejectedWith(input.storeRejectsWith);
      }
      input.recorder.written.push([...forecasts]);
      return Promise.resolve(input.storeOutcome ?? { status: 'complete' });
    },
  },
  log: (entry) => {
    input.recorder.entries.push(entry);
  },
  now: input.now ?? ((): UtcIsoTimestamp => ISSUED_AT),
});

/**
 * The `detail` of an outcome that carries one, or a failure naming what came back
 * instead. A typed narrowing rather than `expect.stringContaining` inside a
 * `toMatchObject`, which types as `any` and would let a wrong-shaped outcome pass.
 */
const detailOf = (outcome: MessageOutcome): string => {
  if (outcome.status !== 'failed' && outcome.status !== 'malformed') {
    throw new Error(`expected a failed or malformed outcome, got '${outcome.status}'`);
  }
  return outcome.detail;
};

const storageError = (operation: string, table: string): StorageError =>
  new StorageError({ operation, table }, { cause: new Error('the table said no') });

describe('consuming one weather message', () => {
  it('forecasts every active site at the location and writes the rows', async () => {
    const recorder = emptyRecorder();
    const readings = [
      reading({ validTime: '2026-07-31T11:00:00Z' }),
      reading({ validTime: '2026-07-31T12:00:00Z' }),
    ];

    const outcome = await consumeMessage(
      deps({
        recorder,
        sites: [sitePhysics(), sitePhysics({ id: RATHMINES_ID, latitude: 53.3201 })],
      }),
      recordOf('m-1', readings),
    );

    expect(outcome).toEqual({
      messageId: 'm-1',
      status: 'stored',
      siteCount: 2,
      forecastCount: 4,
    });
    expect(recorder.written).toHaveLength(1);
    expect(recorder.written[0]).toHaveLength(4);
  });

  it('looks the sites up by the location id the readings round to', async () => {
    const recorder = emptyRecorder();

    await consumeMessage(deps({ recorder }), recordOf('m-1', [reading()]));

    // The same `locationId` bucket ingestion keyed the fetch on — 53.3245,-6.2601
    // rounded to two places.
    expect(recorder.locationsQueried).toEqual(['53.32,-6.26']);
  });

  it('stamps every row with the vintage the clock returned, read once per message', async () => {
    const recorder = emptyRecorder();
    let reads = 0;
    const tick = (): UtcIsoTimestamp => {
      reads += 1;
      return ISSUED_AT;
    };

    await consumeMessage(
      deps({ recorder, now: tick }),
      recordOf('m-1', [reading({ validTime: '2026-07-31T11:00:00Z' }), reading()]),
    );

    // One vintage per message: every row of one message belongs to one
    // identifiable forecast run.
    expect(reads).toBe(1);
    expect(recorder.written[0]?.map((forecast) => forecast.issuedAt)).toEqual([
      ISSUED_AT,
      ISSUED_AT,
    ]);
  });

  it('succeeds without writing when every site at the location has been deactivated', async () => {
    const recorder = emptyRecorder();

    const outcome = await consumeMessage(
      deps({ recorder, sites: [] }),
      recordOf('m-1', [reading()]),
    );

    expect(outcome).toEqual({ messageId: 'm-1', status: 'no-active-sites' });
    expect(recorder.written).toEqual([]);
  });

  it('reports a body that is not JSON as malformed', async () => {
    const recorder = emptyRecorder();

    const outcome = await consumeMessage(deps({ recorder }), {
      messageId: 'm-1',
      body: 'not json at all',
    });

    expect(outcome.messageId).toBe('m-1');
    expect(detailOf(outcome)).toContain('not JSON');
    expect(recorder.locationsQueried).toEqual([]);
  });

  it('reports a body that is JSON of the wrong shape as malformed, naming the field', async () => {
    const outcome = await consumeMessage(deps({ recorder: emptyRecorder() }), {
      messageId: 'm-1',
      body: JSON.stringify([{ ...reading(), temperature2mC: 5000 }]),
    });

    expect(outcome.status).toBe('malformed');
    expect(detailOf(outcome)).toContain('temperature2mC');
  });

  it('reports an empty readings array as malformed — a message that says nothing', async () => {
    const outcome = await consumeMessage(deps({ recorder: emptyRecorder() }), recordOf('m-1', []));

    expect(outcome.status).toBe('malformed');
  });

  it('reports an archive reading as malformed — this queue triggers forecasting only', async () => {
    const outcome = await consumeMessage(deps({ recorder: emptyRecorder() }), {
      messageId: 'm-1',
      body: JSON.stringify([{ ...reading(), kind: 'archive' }]),
    });

    expect(outcome.status).toBe('malformed');
  });

  it('refuses a message that mixes two locations rather than picking one', async () => {
    const recorder = emptyRecorder();
    // Dublin and Bristol: two `locationId` buckets in one body. Fanning this out
    // would run one location's weather against the other's sites.
    const mixed = [reading(), reading({ latitude: 51.45, longitude: -2.59 })];

    const outcome = await consumeMessage(deps({ recorder }), recordOf('m-1', mixed));

    expect(detailOf(outcome)).toContain('exactly one location');
    expect(recorder.locationsQueried).toEqual([]);
  });

  it('accepts co-located readings that round into one bucket', async () => {
    const recorder = emptyRecorder();
    // ~50 m apart: the same two-decimal bucket, which is the whole point of the
    // rounding. An exact-coordinate check would reject this.
    const coLocated = [reading(), reading({ latitude: 53.3249, longitude: -6.2597 })];

    const outcome = await consumeMessage(deps({ recorder }), recordOf('m-1', coLocated));

    expect(outcome.status).toBe('stored');
    expect(recorder.locationsQueried).toEqual(['53.32,-6.26']);
  });

  it('reports an incomplete drain as store-partial, with the count', async () => {
    const outcome = await consumeMessage(
      deps({
        recorder: emptyRecorder(),
        storeOutcome: { status: 'partial', unprocessedCount: 7 },
      }),
      recordOf('m-1', [reading()]),
    );

    expect(outcome).toEqual({ messageId: 'm-1', status: 'store-partial', unprocessedCount: 7 });
  });

  it('converts a rejected site lookup into a failed outcome naming that operation', async () => {
    const outcome = await consumeMessage(
      deps({
        recorder: emptyRecorder(),
        sitesRejectsWith: storageError('listActiveSitePhysicsAtLocation', 'cumulo-sites-test'),
      }),
      recordOf('m-1', [reading()]),
    );

    expect(outcome.status).toBe('failed');
    expect(detailOf(outcome)).toContain('listActiveSitePhysicsAtLocation threw');
    expect(detailOf(outcome)).toContain('StorageError');
  });

  it('converts a rejected series write into a failed outcome naming that operation', async () => {
    const recorder = emptyRecorder();

    const outcome = await consumeMessage(
      deps({ recorder, storeRejectsWith: storageError('putForecasts', 'cumulo-series-test') }),
      recordOf('m-1', [reading()]),
    );

    expect(detailOf(outcome)).toContain('putForecasts threw');
    expect(recorder.written).toEqual([]);
  });

  it('fails the record for a physically implausible hour, naming the site and the hour', async () => {
    // The route `@cumulo/forecast` documents: a near-grazing sun on a vertical
    // array pointed straight at it, with every irradiance field at its schema cap,
    // amplifies the circumsolar term until the chain produces numbers outside
    // `forecastSchema`'s bounds. Both inputs are schema-valid, so the package
    // reports it as a value and this service decides the policy: fail the record —
    // the queue's redrive is the retry, and the DLQ is the operator signal. The
    // detail has to carry the site and hour, because that pair is what an operator
    // reading the DLQ looks up; "something threw" costs them the hour instead.
    const implausible = reading({
      validTime: '2026-03-20T07:00:00Z',
      shortwaveRadiationWm2: 1500,
      directRadiationWm2: 1500,
      diffuseRadiationWm2: 1500,
      directNormalIrradianceWm2: 1500,
    });

    const recorder = emptyRecorder();

    const outcome = await consumeMessage(
      deps({
        recorder,
        sites: [sitePhysics({ tiltDegrees: 90, azimuthDegrees: 89.47 })],
      }),
      recordOf('m-1', [implausible]),
    );

    expect(outcome.status).toBe('failed');
    expect(detailOf(outcome)).toContain(RANELAGH_ID);
    expect(detailOf(outcome)).toContain('2026-03-20T07:00:00Z');
    // Nothing is written: the whole message fails, so redelivery rewrites the same
    // rows rather than layering a second vintage over a half-stored horizon.
    expect(recorder.written).toEqual([]);
  });

  it('describes a non-Error rejection rather than losing it', async () => {
    // JavaScript allows throwing anything, and a naive `.message` would render
    // `undefined` and lose the incident.
    const outcome = await consumeMessage(
      deps({ recorder: emptyRecorder(), storeRejectsWith: 'the table is on fire' }),
      recordOf('m-1', [reading()]),
    );

    expect(detailOf(outcome)).toContain('non-Error thrown (string)');
  });

  it('logs nothing itself — the record boundary above it decides what to say', async () => {
    const recorder = emptyRecorder();

    await consumeMessage(deps({ recorder }), recordOf('m-1', [reading()]));

    expect(recorder.entries).toEqual([]);
  });

  it('writes rows attributed to the site they were forecast for', async () => {
    const recorder = emptyRecorder();

    await consumeMessage(deps({ recorder }), recordOf('m-1', [reading()]));

    expect(recorder.written[0]?.[0]?.siteId).toBe(RANELAGH_ID);
  });
});
