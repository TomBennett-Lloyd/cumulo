import type { Forecast } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createStorageDocumentClient } from '../../client';
import { RecordingHttpHandler, firstRequestBody } from '../../recording-http-handler';

import { SeriesAdapter } from './series-adapter';
import { EXPIRES_AT_14H, TABLE_NAME, forecast, offlineBaseClient } from './series-fixtures';

/**
 * These run a genuine document client against a recording HTTP handler, so
 * lib-dynamodb's marshalling middleware actually executes. An SDK-level stub
 * would skip it and prove nothing about what reaches DynamoDB — which is the
 * whole question here, because the item this adapter hands the client may carry
 * an explicitly-`undefined` optional field.
 */

const batchWriteBodySchema = z.object({
  RequestItems: z.record(
    z.string(),
    z.array(z.object({ PutRequest: z.object({ Item: z.record(z.string(), z.unknown()) }) })),
  ),
});

/** The marshalled `AttributeValue` items of the single request that was sent. */
const marshalledItems = (handler: RecordingHttpHandler): Record<string, unknown>[] => {
  const entries = batchWriteBodySchema.parse(firstRequestBody(handler)).RequestItems[TABLE_NAME];
  if (entries === undefined) {
    throw new Error(`the request did not target ${TABLE_NAME}`);
  }
  return entries.map((entry) => entry.PutRequest.Item);
};

const liveAdapter = (handler: RecordingHttpHandler): SeriesAdapter =>
  new SeriesAdapter({
    client: createStorageDocumentClient({ baseClient: offlineBaseClient(handler) }),
    tableName: TABLE_NAME,
  });

describe('putForecasts marshalling', () => {
  it('writes a forecast whose uncertainty field is absent', async () => {
    const handler = new RecordingHttpHandler();
    const point = forecast();
    expect(Object.hasOwn(point, 'uncertainty')).toBe(false);

    expect(await liveAdapter(handler).putForecasts([point])).toEqual({ status: 'complete' });

    const [item] = marshalledItems(handler);
    expect(item?.uncertainty).toBeUndefined();
    expect(item?.expiresAt).toEqual({ N: String(EXPIRES_AT_14H) });
    expect(item?.sk).toEqual({ S: 'T#2026-07-30T14:00:00Z#FC#physics' });
  });

  it('writes a forecast whose uncertainty field is explicitly undefined', async () => {
    const handler = new RecordingHttpHandler();
    // The shape `{ ...forecast }` produces under exactOptionalPropertyTypes when
    // the optional band was never set: the key exists, the value is undefined.
    const point: Forecast = { ...forecast(), uncertainty: undefined };
    expect(Object.hasOwn(point, 'uncertainty')).toBe(true);

    expect(await liveAdapter(handler).putForecasts([point])).toEqual({ status: 'complete' });

    const [item] = marshalledItems(handler);
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'acPowerKw',
      'expiresAt',
      'issuedAt',
      'model',
      'poaIrradianceWm2',
      'siteId',
      'sk',
      'validTime',
      'weatherSource',
    ]);
  });

  it('marshals a present uncertainty band as a nested map', async () => {
    const handler = new RecordingHttpHandler();
    const point = forecast({ model: 'ml', uncertainty: { p10AcPowerKw: 2.8, p90AcPowerKw: 3.9 } });

    await liveAdapter(handler).putForecasts([point]);

    const [item] = marshalledItems(handler);
    expect(item?.uncertainty).toEqual({
      M: { p10AcPowerKw: { N: '2.8' }, p90AcPowerKw: { N: '3.9' } },
    });
  });
});
