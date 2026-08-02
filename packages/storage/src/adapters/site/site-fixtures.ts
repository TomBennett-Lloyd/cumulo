import {
  DynamoDBClient,
  TransactionCanceledException,
  TransactionConflictException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fleetSiteSchema, type FleetSite } from '@cumulo/shared';
import { mockClient } from 'aws-sdk-client-mock';

import { createStorageDocumentClient } from '../../client';

import { SiteAdapter } from './site-adapter';

/**
 * Fixtures shared by this folder's tests — the domain builder, the stored items
 * as the wire has them, and the adapter under test.
 *
 * Test support: it is one module rather than a copy in each test file because
 * these fixtures encode one thing (what a `cumulo-sites` item looks like), and
 * a change to that shape has to reach every test at once.
 */

export const TABLE_NAME = 'cumulo-sites-test';

export const RANELAGH_ID = '3f1a2b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';
export const RATHMINES_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const GALWAY_ID = 'b1e9f0a2-3c4d-4e5f-9a8b-7c6d5e4f3a2b';

type FleetSiteOverrides = Partial<Omit<FleetSite, 'createdAt'>> & { readonly createdAt?: string };

export const fleetSite = (overrides: FleetSiteOverrides = {}): FleetSite =>
  fleetSiteSchema.parse({
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

/**
 * A stored item exactly as the document client hands it back, written out
 * literally rather than produced by `toItem` — a fixture that agreed with the
 * code under test by construction would prove nothing about the wire shape.
 */
export const ranelaghItem = {
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

export const rathminesItem = {
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

export const galwayItem = {
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
export const ranelaghProjectedItem = {
  gsiLocation: '53.32,-6.26',
  pk: 'FLEET',
  siteId: RANELAGH_ID,
  latitude: 53.3245,
  longitude: -6.2601,
  tiltDegrees: 35,
  azimuthDegrees: 180,
  capacityKw: 4.2,
};

export const ddbMock = mockClient(DynamoDBDocumentClient);

/**
 * A `TransactWriteItems` rejection as DynamoDB really sends one: one
 * cancellation reason per requested item, in request order, with `None` for the
 * items that were fine.
 *
 * Built from the SDK's own exception class rather than from a hand-made object
 * with a matching `name`, because the ordering-and-shape of
 * `CancellationReasons` is the assumption `SiteAdapter`'s cap and eviction
 * logic rests on — a stand-in would pin the stand-in.
 */
export const transactionCancelled = (...codes: readonly string[]): TransactionCanceledException =>
  new TransactionCanceledException({
    message: 'Transaction cancelled, please refer cancellation reasons for specific reasons',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

/**
 * A whole-request conflict as DynamoDB sends one when a `TransactWriteItems`
 * collides with another in-flight transaction on the same row — the standalone
 * exception rather than a per-item cancellation reason.
 *
 * Built from the SDK's own class for the same reason `transactionCancelled` is:
 * `SiteAdapter` classifies it with `instanceof`, so a hand-made object with a
 * matching `name` would pin the stand-in instead of the assumption.
 */
export const transactionConflict = (): TransactionConflictException =>
  new TransactionConflictException({
    message: 'Transaction is ongoing for the item.',
    $metadata: {},
  });

/** The code DynamoDB reports for an item whose `ConditionExpression` was false. */
export const CONDITION_FAILED = 'ConditionalCheckFailed';

/** The code DynamoDB reports for an item cancelled by a concurrent transaction. */
export const TRANSACTION_CONFLICT = 'TransactionConflict';

/** The code DynamoDB reports for an item that was itself fine. */
export const NO_REASON = 'None';

export const adapter = (): SiteAdapter =>
  new SiteAdapter({
    client: createStorageDocumentClient({
      baseClient: new DynamoDBClient({
        region: 'eu-west-1',
        credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret' },
      }),
    }),
    tableName: TABLE_NAME,
  });

/** A stored item with one attribute taken away, to stand in for a drifted table. */
export const without = (
  item: Record<string, unknown>,
  attribute: string,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(item).filter(([name]) => name !== attribute));
