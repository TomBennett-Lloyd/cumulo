import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it } from 'vitest';

import { StorageError } from '../../errors';
import { captureStorageError } from '../storage-error-capture';

import {
  GALWAY_ID,
  RANELAGH_ID,
  RATHMINES_ID,
  TABLE_NAME,
  adapter,
  ddbMock,
  fleetSite,
  galwayItem,
  ranelaghItem,
  ranelaghProjectedItem,
  rathminesItem,
  without,
} from './site-fixtures';

/**
 * These are contract tests in the sense `docs/standards/testing.md` rule 3
 * means: every assertion is either on a **captured command input** — the exact
 * request this adapter would put on the wire — or on the domain value it
 * derives from a **fixture response** shaped like DynamoDB's. Nothing here
 * asserts that a mock was called.
 *
 * The pure key-attribute logic is pinned separately, in `site-item.test.ts`.
 */

beforeEach(() => {
  ddbMock.reset();
});

describe('putFleetSite', () => {
  it('writes the whole item, index attributes included', async () => {
    await adapter().putFleetSite(fleetSite({ origin: 'user' }));

    const [call] = ddbMock.commandCalls(PutCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Item: {
        ...ranelaghItem,
        origin: 'user',
        gsiUserSites: 'USER',
        gsiCreatedAt: `2026-07-30T14:00:00Z#${RANELAGH_ID}`,
      },
    });
  });
});

describe('getFleetSite', () => {
  it('addresses the item by the fleet partition and the site id', async () => {
    ddbMock.on(GetCommand).resolves({ Item: ranelaghItem });

    await adapter().getFleetSite(RANELAGH_ID);

    const [call] = ddbMock.commandCalls(GetCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { pk: 'FLEET', siteId: RANELAGH_ID },
    });
  });

  it('parses a found item back into a domain site', async () => {
    ddbMock.on(GetCommand).resolves({ Item: ranelaghItem });

    const result = await adapter().getFleetSite(RANELAGH_ID);

    expect(result).toEqual({ found: true, site: fleetSite() });
  });

  it('reports a missing item as a value rather than an error', async () => {
    ddbMock.on(GetCommand).resolves({});

    expect(await adapter().getFleetSite(RANELAGH_ID)).toEqual({ found: false });
  });
});

describe('deleteFleetSite', () => {
  it('asks for the old item so that "was anything deleted" is answerable', async () => {
    ddbMock.on(DeleteCommand).resolves({ Attributes: ranelaghItem });

    const result = await adapter().deleteFleetSite(RANELAGH_ID);

    const [call] = ddbMock.commandCalls(DeleteCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { pk: 'FLEET', siteId: RANELAGH_ID },
      ReturnValues: 'ALL_OLD',
    });
    expect(result).toEqual({ deleted: true });
  });

  it('reports deleting nothing when the item was already gone', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    expect(await adapter().deleteFleetSite(RANELAGH_ID)).toEqual({ deleted: false });
  });
});

describe('listFleetSites', () => {
  it('queries the fleet partition from the lowest possible site id', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [ranelaghItem] });

    await adapter().listFleetSites();

    const [call] = ddbMock.commandCalls(QueryCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :fleet AND siteId >= :minSiteId',
      ExpressionAttributeValues: { ':fleet': 'FLEET', ':minSiteId': '0' },
    });
  });

  it('concatenates every page and follows LastEvaluatedKey', async () => {
    const lastEvaluatedKey = { pk: 'FLEET', siteId: RATHMINES_ID };
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [ranelaghItem, rathminesItem], LastEvaluatedKey: lastEvaluatedKey })
      .resolvesOnce({ Items: [galwayItem] });

    const sites = await adapter().listFleetSites();

    expect(sites.map((site) => site.id)).toEqual([RANELAGH_ID, RATHMINES_ID, GALWAY_ID]);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args[0].input).not.toHaveProperty('ExclusiveStartKey');
    expect(calls[1]?.args[0].input.ExclusiveStartKey).toEqual(lastEvaluatedKey);
  });

  it('returns an empty fleet for an empty partition', async () => {
    ddbMock.on(QueryCommand).resolves({});

    expect(await adapter().listFleetSites()).toEqual([]);
  });

  it('parses items of every origin and activity state', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [ranelaghItem, rathminesItem] });

    const sites = await adapter().listFleetSites();

    expect(sites).toEqual([
      fleetSite(),
      fleetSite({
        id: RATHMINES_ID,
        name: 'Rathmines terrace',
        latitude: 53.3201,
        longitude: -6.2652,
        tiltDegrees: 30,
        azimuthDegrees: 170,
        capacityKw: 3.5,
        origin: 'user',
        createdAt: '2026-07-29T09:30:00Z',
        active: false,
      }),
    ]);
  });
});

describe('listActiveSitePhysicsAtLocation', () => {
  it('queries the by-location index on the location id alone', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [ranelaghProjectedItem] });

    await adapter().listActiveSitePhysicsAtLocation('53.32,-6.26');

    const [call] = ddbMock.commandCalls(QueryCommand);
    expect(call?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      IndexName: 'by-location',
      KeyConditionExpression: 'gsiLocation = :location',
      ExpressionAttributeValues: { ':location': '53.32,-6.26' },
    });
  });

  it('parses the projected attributes into physics parameters without a name', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [ranelaghProjectedItem] });

    expect(await adapter().listActiveSitePhysicsAtLocation('53.32,-6.26')).toEqual([
      {
        id: RANELAGH_ID,
        latitude: 53.3245,
        longitude: -6.2601,
        tiltDegrees: 35,
        azimuthDegrees: 180,
        capacityKw: 4.2,
      },
    ]);
  });

  it('throws when the index returns an item missing a projected attribute', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [without(ranelaghProjectedItem, 'capacityKw')] });

    await expect(adapter().listActiveSitePhysicsAtLocation('53.32,-6.26')).rejects.toThrow();
  });
});

describe('read consistency', () => {
  it('never asks for a consistent read (ADR 0002 sized reads as eventually consistent)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: ranelaghItem });
    ddbMock.on(QueryCommand).resolves({ Items: [ranelaghItem] });
    ddbMock.on(DeleteCommand).resolves({});
    const sites = adapter();

    await sites.putFleetSite(fleetSite());
    await sites.getFleetSite(RANELAGH_ID);
    await sites.deleteFleetSite(RANELAGH_ID);
    await sites.listFleetSites();
    await sites.listActiveSitePhysicsAtLocation('53.32,-6.26');

    const inputs: unknown[] = [
      ...ddbMock.commandCalls(PutCommand).map((call) => call.args[0].input),
      ...ddbMock.commandCalls(GetCommand).map((call) => call.args[0].input),
      ...ddbMock.commandCalls(DeleteCommand).map((call) => call.args[0].input),
      ...ddbMock.commandCalls(QueryCommand).map((call) => call.args[0].input),
    ];
    expect(inputs).toHaveLength(5);
    for (const input of inputs) {
      expect(input).not.toHaveProperty('ConsistentRead');
    }
  });
});

describe('failure reporting', () => {
  const cause = new Error('ProvisionedThroughputExceededException');

  it('wraps a rejected write with the operation, table and key', async () => {
    ddbMock.on(PutCommand).rejects(cause);

    const error = await captureStorageError(() => adapter().putFleetSite(fleetSite()));

    expect(error.context).toEqual({
      operation: 'putFleetSite',
      table: TABLE_NAME,
      key: { pk: 'FLEET', siteId: RANELAGH_ID },
    });
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toContain(TABLE_NAME);
  });

  it('wraps a rejected read of one item with its key', async () => {
    ddbMock.on(GetCommand).rejects(cause);

    const error = await captureStorageError(() => adapter().getFleetSite(RANELAGH_ID));

    expect(error.context).toEqual({
      operation: 'getFleetSite',
      table: TABLE_NAME,
      key: { pk: 'FLEET', siteId: RANELAGH_ID },
    });
  });

  it('wraps a rejected query, which has no single key to report', async () => {
    ddbMock.on(QueryCommand).rejects(cause);

    const error = await captureStorageError(() => adapter().listFleetSites());

    expect(error.context).toEqual({ operation: 'listFleetSites', table: TABLE_NAME });
    expect(error.context.key).toBeUndefined();
  });

  it('surfaces a rejection on a later page rather than the pages already read', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [ranelaghItem],
        LastEvaluatedKey: { pk: 'FLEET', siteId: RANELAGH_ID },
      })
      .rejects(cause);

    const error = await captureStorageError(() => adapter().listFleetSites());

    expect(error.context.operation).toBe('listFleetSites');
  });

  it('does not disguise a drifted item as an infrastructure failure', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ ...ranelaghItem, capacityKw: '4.2' }] });

    const rejection: unknown = await adapter()
      .listFleetSites()
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(StorageError);
  });
});
