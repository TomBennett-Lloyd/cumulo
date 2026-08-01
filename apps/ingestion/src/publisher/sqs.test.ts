import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  forecastWeatherReadingSchema,
  weatherMessageSchema,
  weatherReadingSchema,
  type ForecastWeatherReading,
} from '@cumulo/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { INGESTION_SEND_MAX_ATTEMPTS, SqsWeatherPublisher, createIngestionSqsClient } from './sqs';

/**
 * Contract tests for the SQS publisher: every assertion is on the command input
 * that would reach SQS, or on what this module refuses to send at all
 * (`docs/standards/testing.md` rule 3). Nothing here asserts "the mock was called".
 *
 * The body is the interesting surface, because it is the only part of ADR 0004's
 * decision that code on the other side of the queue depends on. So the tests parse
 * the bytes back with the *shared* schema rather than comparing them to the object
 * that went in — that is exactly what #12 will do, and it is the only check that
 * catches a normalization change that this service considers fine and the domain
 * does not.
 */

const QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/cumulo-weather-readings-test';

/** Dublin, at the centre of its `locationId` bucket. */
const DUBLIN = { latitude: 53.35, longitude: -6.26 };

const readingAt = (hour: number): ForecastWeatherReading =>
  forecastWeatherReadingSchema.parse({
    latitude: DUBLIN.latitude,
    longitude: DUBLIN.longitude,
    validTime: `2026-07-31T${String(hour % 24).padStart(2, '0')}:00:00Z`,
    kind: 'forecast',
    source: 'open-meteo',
    shortwaveRadiationWm2: 400,
    directRadiationWm2: 250,
    diffuseRadiationWm2: 150,
    directNormalIrradianceWm2: 600,
    temperature2mC: 18,
    windSpeed10mMs: 3,
    cloudCoverPct: 40,
  });

/** A full 48-hour horizon — the payload one location actually publishes. */
const horizon = (): ForecastWeatherReading[] =>
  Array.from({ length: 48 }, (_unused, index) => readingAt(index));

const sqsMock = mockClient(SQSClient);
const client = new SQSClient({
  region: 'eu-west-1',
  credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret-access-key' },
});

const publisher = (): SqsWeatherPublisher =>
  new SqsWeatherPublisher({ client, queueUrl: QUEUE_URL });

/** The inputs of every `SendMessage` the publisher issued this test. */
const sends = (): SendMessageCommand['input'][] =>
  sqsMock.commandCalls(SendMessageCommand).map((call) => call.args[0].input);

/** The single message body sent this test, as the string that would sit on the queue. */
const onlyBody = (): string => {
  const [only, ...rest] = sends();
  if (only === undefined || rest.length > 0) {
    throw new Error(`expected exactly one SendMessage, got ${String(sends().length)}`);
  }
  if (only.MessageBody === undefined) {
    throw new Error('SendMessage carried no MessageBody');
  }
  return only.MessageBody;
};

/** The rejection reason, or a failure if the promise resolved after all. */
const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );

beforeEach(() => {
  sqsMock.reset();
});

afterAll(() => {
  sqsMock.restore();
});

describe('SqsWeatherPublisher', () => {
  it('the message body parses against the shared weather reading schema array', async () => {
    const readings = horizon();

    await publisher().publishLocationReadings(readings);

    // Parsed, not compared: the assertion is that the bytes on the queue satisfy
    // the domain contract, which is the promise #12 consumes them on.
    const parsed = weatherMessageSchema.parse(JSON.parse(onlyBody()));
    expect(parsed).toEqual(readings);
  });

  it('publishes one message per location, carrying that location whole horizon', async () => {
    await publisher().publishLocationReadings(horizon());

    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.QueueUrl).toBe(QUEUE_URL);
    expect(weatherMessageSchema.parse(JSON.parse(onlyBody()))).toHaveLength(48);
  });

  it('provenance rides on every reading source, not on the envelope', async () => {
    await publisher().publishLocationReadings(horizon());

    const parsed = weatherMessageSchema.parse(JSON.parse(onlyBody()));
    expect(parsed.map((reading) => reading.source)).toEqual(Array<string>(48).fill('open-meteo'));
    // Nothing about the payload's meaning is carried outside the body, so a message
    // separated from its queue still says where its data came from.
    expect(sends()[0]?.MessageAttributes).toBeUndefined();
  });

  it('readings that fail schema validation throw before any send', async () => {
    // 999 °C is the signature of a unit or column mistake, not of weather. The
    // readings are already in `cumulo-weather` by the time a publish runs, so the
    // only thing this throw costs is one location's message — and the alternative
    // is #12 acting on a value outside the domain's physical bounds.
    const readings = horizon();
    const bad = { ...readingAt(0), temperature2mC: 999 };

    const error = await rejectionOf(publisher().publishLocationReadings([...readings, bad]));

    expect(error).toBeInstanceOf(z.ZodError);
    expect(sends()).toEqual([]);
  });

  it('a reading whose cloud cover is out of range throws before any send', async () => {
    const bad = { ...readingAt(0), cloudCoverPct: 150 };

    await expect(publisher().publishLocationReadings([bad])).rejects.toBeInstanceOf(z.ZodError);
    expect(sends()).toEqual([]);
  });

  it('refuses to publish a location with no readings, without sending', async () => {
    const error = await rejectionOf(publisher().publishLocationReadings([]));

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('no readings');
    expect(sends()).toEqual([]);
  });

  it('the body carries the shared schema fields and nothing else', async () => {
    // Zod strips what it does not know about, which is what makes the schema the
    // wire format rather than a description of it: a field added to this service's
    // internal reading shape cannot leak onto the queue unannounced.
    const strayField = { ...readingAt(0), internalDebugTag: 'do-not-ship' };

    await publisher().publishLocationReadings([strayField]);

    const [first] = weatherMessageSchema.parse(JSON.parse(onlyBody()));
    expect(Object.keys(weatherReadingSchema.shape)).toContain('source');
    expect(first).toEqual(readingAt(0));
    expect(onlyBody()).not.toContain('internalDebugTag');
  });

  it('a 48-hour horizon message is far inside the SQS 256 KB limit', async () => {
    // ADR 0004 costed the transport on ~15-20 KB per location message and rejected
    // designing around the limit. This is that claim, measured rather than assumed.
    await publisher().publishLocationReadings(horizon());

    const bytes = Buffer.byteLength(onlyBody(), 'utf8');
    expect(bytes).toBeGreaterThan(10_000);
    expect(bytes).toBeLessThan(256 * 1024 * 0.25);
  });
});

describe('createIngestionSqsClient', () => {
  it('pins the attempt budget rather than inheriting it', async () => {
    // testing.md rule 7: every test above runs against an injected client, so
    // the configuration production actually ships needs its own assertion. The
    // SDK's own default here is an environment-dependent attempt count.
    const shipped = createIngestionSqsClient();

    await expect(shipped.config.maxAttempts()).resolves.toBe(INGESTION_SEND_MAX_ATTEMPTS);
  });
});
