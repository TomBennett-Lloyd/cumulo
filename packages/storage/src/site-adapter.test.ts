import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { fleetSiteSchema, type FleetSite } from '@cumulo/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { createStorageDocumentClient } from './client';
import { StorageError } from './errors';
import { createSiteAdapter, fromItem, toItem, type SiteAdapter } from './site-adapter';

/**
 * These are contract tests in the sense `docs/standards/testing.md` rule 3
 * means: every assertion is either on a **captured command input** — the exact
 * request this adapter would put on the wire — or on the domain value it
 * derives from a **fixture response** shaped like DynamoDB's. Nothing here
 * asserts that a mock was called.
 *
 * The key-attribute logic that carries the real risk (sparse GSI attributes,
 * the `siteId >= '0'` bound) is pure, so it is pinned directly on
 * `toItem`/`fromItem` as well as through the adapter.
 */

const TABLE_NAME = 'cumulo-sites-test';

const RANELAGH_ID = '3f1a2b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';
const RATHMINES_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const GALWAY_ID = 'b1e9f0a2-3c4d-4e5f-9a8b-7c6d5e4f3a2b';

type FleetSiteOverrides = Partial<Omit<FleetSite, 'createdAt'>> & { readonly createdAt?: string };

function fleetSite(overrides: FleetSiteOverrides = {}): FleetSite {
  return fleetSiteSchema.parse({
    id: RANELAGH_ID,
    name: 'Ranelagh rooftop',
    latitude: 53.3245,
    longitude: -6.2601,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw: 4.2,
    origin: 'seed',
    createdAt: '2026-07-30T14:00:00Z',
    active: true,
    ...overrides,
  });
}

/**
 * A stored item exactly as the document client hands it back, written out
 * literally rather than produced by `toItem` — a fixture that agreed with the
 * code under test by construction would prove nothing about the wire shape.
 */
const ranelaghItem = {
  pk: 'FLEET',
  siteId: RANELAGH_ID,
  name: 'Ranelagh rooftop',
  latitude: 53.3245,
  longitude: -6.2601,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.2,
  origin: 'seed',
  createdAt: '2026-07-30T14:00:00Z',
  active: true,
  locationId: '53.32,-6.26',
  gsiLocation: '53.32,-6.26',
};

const rathminesItem = {
  pk: 'FLEET',
  siteId: RATHMINES_ID,
  name: 'Rathmines terrace',
  latitude: 53.3201,
  longitude: -6.2652,
  tiltDegrees: 30,
  azimuthDegrees: 170,
  capacityKw: 3.5,
  origin: 'user',
  createdAt: '2026-07-29T09:30:00Z',
  active: false,
  locationId: '53.32,-6.27',
  gsiUserSites: 'USER',
  gsiCreatedAt: `2026-07-29T09:30:00Z#${RATHMINES_ID}`,
};

const galwayItem = {
  pk: 'FLEET',
  siteId: GALWAY_ID,
  name: 'Salthill bungalow',
  latitude: 53.2611,
  longitude: -9.0713,
  tiltDegrees: 25,
  azimuthDegrees: 195,
  capacityKw: 6,
  origin: 'seed',
  createdAt: '2026-07-28T08:00:00Z',
  active: true,
  locationId: '53.26,-9.07',
  gsiLocation: '53.26,-9.07',
};

/** What the `by-location` index actually projects: the two keys plus INCLUDE. */
const ranelaghProjectedItem = {
  gsiLocation: '53.32,-6.26',
  pk: 'FLEET',
  siteId: RANELAGH_ID,
  latitude: 53.3245,
  longitude: -6.2601,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.2,
};

const ddbMock = mockClient(DynamoDBDocumentClient);

function adapter(): SiteAdapter {
  return createSiteAdapter({
    client: createStorageDocumentClient({
      baseClient: new DynamoDBClient({
        region: 'eu-west-1',
        credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret' },
      }),
    }),
    tableName: TABLE_NAME,
  });
}

/** A stored item with one attribute taken away, to stand in for a drifted table. */
function without(item: Record<string, unknown>, attribute: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([name]) => name !== attribute));
}

async function captureStorageError(run: () => Promise<unknown>): Promise<StorageError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof StorageError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the operation to reject with a StorageError');
}

beforeEach(() => {
  ddbMock.reset();
});

describe('toItem', () => {
  it('renames id to the siteId key attribute and computes pk and locationId', () => {
    expect(toItem(fleetSite())).toEqual(ranelaghItem);
  });

  const sparseMatrix = [
    {
      description: 'an active seed site is in by-location only',
      overrides: { origin: 'seed', active: true },
      indexAttributes: { gsiLocation: '53.32,-6.26' },
    },
    {
      description: 'an inactive seed site is in neither index',
      overrides: { origin: 'seed', active: false },
      indexAttributes: {},
    },
    {
      description: 'an active user site is in both indexes',
      overrides: { origin: 'user', active: true },
      indexAttributes: {
        gsiLocation: '53.32,-6.26',
        gsiUserSites: 'USER',
        gsiCreatedAt: `2026-07-30T14:00:00Z#${RANELAGH_ID}`,
      },
    },
    {
      description: 'an inactive user site stays evictable but leaves by-location',
      overrides: { origin: 'user', active: false },
      indexAttributes: {
        gsiUserSites: 'USER',
        gsiCreatedAt: `2026-07-30T14:00:00Z#${RANELAGH_ID}`,
      },
    },
  ] as const;

  for (const { description, overrides, indexAttributes } of sparseMatrix) {
    it(description, () => {
      const item: Record<string, unknown> = toItem(fleetSite(overrides));
      const written = Object.fromEntries(
        Object.entries(item).filter(([attribute]) => attribute.startsWith('gsi')),
      );

      expect(written).toEqual(indexAttributes);
    });
  }
});

describe('fromItem', () => {
  const roundTrips = [
    { description: 'seed and active', overrides: { origin: 'seed', active: true } },
    { description: 'seed and inactive', overrides: { origin: 'seed', active: false } },
    { description: 'user and active', overrides: { origin: 'user', active: true } },
    { description: 'user and inactive', overrides: { origin: 'user', active: false } },
  ] as const;

  for (const { description, overrides } of roundTrips) {
    it(`round-trips a site that is ${description}`, () => {
      const site = fleetSite(overrides);

      expect(fromItem(toItem(site))).toEqual(site);
    });
  }

  it('returns no key attributes as domain fields', () => {
    expect(Object.keys(fromItem(ranelaghItem)).sort()).toEqual([
      'active',
      'azimuthDegrees',
      'capacityKw',
      'createdAt',
      'id',
      'latitude',
      'longitude',
      'name',
      'origin',
      'tiltDegrees',
    ]);
  });

  it('throws on an item the schema does not recognise', () => {
    expect(() => fromItem(without(ranelaghItem, 'origin'))).toThrow();
    expect(() => fromItem({ ...ranelaghItem, capacityKw: '4.2' })).toThrow();
  });
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
