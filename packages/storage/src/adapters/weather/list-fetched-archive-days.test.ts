import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { archiveDayMarkerSortKey } from '@cumulo/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StorageError } from '../../errors';
import { captureStorageError } from '../storage-error-capture';

import {
  DUBLIN,
  DUBLIN_ID,
  TABLE,
  adapter,
  ddbMock,
  getInputs,
  hourlyFrom,
  type Item,
} from './weather-fixtures';

/**
 * The other behaviour a partial failure would corrupt quietly (access pattern
 * H2): this reports fetched / unfetched / undetermined, and never coerces
 * undetermined into either neighbour — calling it unfetched spends Open-Meteo
 * quota, calling it fetched skips data that then never arrives.
 */

const FETCHED = '2026-02-10';
const UNFETCHED = '2026-02-11';
const UNDETERMINED = '2026-02-12';

const marker = (day: string): Item => ({
  locationId: DUBLIN_ID,
  sk: archiveDayMarkerSortKey(day),
});

beforeEach(() => {
  ddbMock.reset();
});

afterAll(() => {
  ddbMock.restore();
});

describe('listFetchedArchiveDays', () => {
  it('asks for exactly the requested markers, eventually consistently', async () => {
    ddbMock.on(BatchGetCommand).resolves({});

    await adapter().listFetchedArchiveDays(DUBLIN, [FETCHED, UNFETCHED]);

    const [input] = getInputs();
    const request = input?.RequestItems?.[TABLE];
    expect(request?.Keys).toEqual([marker(FETCHED), marker(UNFETCHED)]);
    // ADR 0002 Consequence 3: a ConsistentRead here would double the read cost
    // of a table provisioned at 3 RCU.
    expect(Object.keys(request ?? {})).not.toContain('ConsistentRead');
  });

  it('separates fetched, unfetched and undetermined days without coercing any of them', async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { [TABLE]: [marker(FETCHED)] },
      UnprocessedKeys: { [TABLE]: { Keys: [marker(UNDETERMINED)] } },
    });

    const coverage = await adapter().listFetchedArchiveDays(DUBLIN, [
      FETCHED,
      UNFETCHED,
      UNDETERMINED,
    ]);

    expect(coverage.status).toBe('incomplete');
    expect(coverage.fetched).toEqual(new Set([FETCHED]));
    expect(coverage.status === 'incomplete' ? coverage.undeterminedDays : []).toEqual([
      UNDETERMINED,
    ]);
    // The unfetched day is in neither bucket — that is what "unfetched" is.
    expect(coverage.fetched.has(UNFETCHED)).toBe(false);
    // And the undetermined day is never reported as fetched: doing so would
    // skip data that then never arrives.
    expect(coverage.fetched.has(UNDETERMINED)).toBe(false);
  });

  it('reports complete once a retry resolves a previously unprocessed key', async () => {
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { [TABLE]: [marker(FETCHED)] },
        UnprocessedKeys: { [TABLE]: { Keys: [marker(UNDETERMINED)] } },
      })
      .resolves({ Responses: { [TABLE]: [marker(UNDETERMINED)] } });

    const coverage = await adapter().listFetchedArchiveDays(DUBLIN, [
      FETCHED,
      UNFETCHED,
      UNDETERMINED,
    ]);

    expect(coverage).toEqual({ status: 'complete', fetched: new Set([FETCHED, UNDETERMINED]) });
    expect(getInputs()).toHaveLength(2);
    expect(getInputs()[1]?.RequestItems?.[TABLE]?.Keys).toEqual([marker(UNDETERMINED)]);
  });

  it('reports every day fetched when every marker comes back', async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { [TABLE]: [marker(FETCHED), marker(UNFETCHED)] },
    });

    expect(await adapter().listFetchedArchiveDays(DUBLIN, [FETCHED, UNFETCHED])).toEqual({
      status: 'complete',
      fetched: new Set([FETCHED, UNFETCHED]),
    });
  });

  it('de-duplicates repeated days, which BatchGetItem would reject', async () => {
    ddbMock.on(BatchGetCommand).resolves({});

    await adapter().listFetchedArchiveDays(DUBLIN, [FETCHED, FETCHED, UNFETCHED]);

    expect(getInputs()[0]?.RequestItems?.[TABLE]?.Keys).toEqual([
      marker(FETCHED),
      marker(UNFETCHED),
    ]);
  });

  it('chunks more than 100 days into separate BatchGet requests', async () => {
    ddbMock.on(BatchGetCommand).resolves({});
    const days = hourlyFrom('2026-01-01T00:00:00Z', 150 * 24)
      .filter((_unused, index) => index % 24 === 0)
      .map((iso) => iso.slice(0, 10));

    await adapter().listFetchedArchiveDays(DUBLIN, days);

    expect(getInputs().map((input) => input.RequestItems?.[TABLE]?.Keys?.length)).toEqual([
      100, 50,
    ]);
  });

  it('sends nothing when asked about no days', async () => {
    ddbMock.on(BatchGetCommand).resolves({});

    expect(await adapter().listFetchedArchiveDays(DUBLIN, [])).toEqual({
      status: 'complete',
      fetched: new Set(),
    });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('rejects a day that is not zero-padded YYYY-MM-DD before sending anything', async () => {
    ddbMock.on(BatchGetCommand).resolves({});

    await expect(adapter().listFetchedArchiveDays(DUBLIN, ['2026-2-10'])).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('fails loudly, and not as an outage, on a marker item it did not write', async () => {
    // A marker carries the two key attributes and nothing else; this one has
    // lost its sort key, so it cannot say which day it vouches for.
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { [TABLE]: [{ locationId: DUBLIN_ID, fetchedAt: '2026-02-10T00:00:00Z' }] },
    });

    const failure = await adapter()
      .listFetchedArchiveDays(DUBLIN, [FETCHED])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(z.ZodError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });

  it('wraps a rejected batch get in a StorageError naming the location', async () => {
    const failure = new Error('ProvisionedThroughputExceededException');
    ddbMock.on(BatchGetCommand).rejects(failure);

    const error = await captureStorageError(() =>
      adapter().listFetchedArchiveDays(DUBLIN, [FETCHED]),
    );

    expect(error.context).toEqual({
      operation: 'listFetchedArchiveDays',
      table: TABLE,
      key: { locationId: DUBLIN_ID },
    });
    expect(error.cause).toBe(failure);
  });
});
