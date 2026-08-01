import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { createStorageDocumentClient } from '../../client';
import { captureStorageError } from '../storage-error-capture';

import { AbuseAdapter } from './abuse-adapter';

/**
 * Contract tests per `docs/standards/testing.md` rule 3: every assertion is on
 * a captured command input — the exact request this adapter would put on the
 * wire — or on the value it derives from a DynamoDB-shaped response.
 *
 * The one behaviour worth stating up front is `getBlock`'s treatment of an
 * expired-but-unreaped row, because it is the difference between a one-hour
 * block and an indefinite one: DynamoDB TTL is asynchronous and typically lands
 * within days, so presence of a block row is never the same fact as the block
 * being in force.
 */

const TABLE_NAME = 'cumulo-abuse-test';
const IP = '203.0.113.7';
const NOW = 1_800_000_100;

const ddbMock = mockClient(DynamoDBDocumentClient);

const offlineClient = (): DynamoDBDocumentClient =>
  createStorageDocumentClient({
    baseClient: new DynamoDBClient({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret' },
    }),
  });

/** The adapter with a stopped clock, so a test can stand either side of an instant. */
const adapter = (): AbuseAdapter =>
  new AbuseAdapter({ client: offlineClient(), tableName: TABLE_NAME, nowEpochSeconds: () => NOW });

/** The adapter exactly as production builds it: no injected clock (rule 7). */
const shippedAdapter = (): AbuseAdapter =>
  new AbuseAdapter({ client: offlineClient(), tableName: TABLE_NAME });

beforeEach(() => {
  ddbMock.reset();
});

describe('incrementRateWindow', () => {
  it('counts atomically and claims the row’s lifetime only once', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { requestCount: 7 } });

    expect(await adapter().incrementRateWindow(IP, 1_800_000_060, 1_800_000_180)).toBe(7);
    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { pk: 'RATE#203.0.113.7#1800000060' },
      // ADD is the atomic counter: two concurrent requests from one address
      // cannot lose an increment between a read and a write. `if_not_exists`
      // is what stops a busy address from pushing its own window's TTL out.
      UpdateExpression: 'ADD requestCount :one SET expiresAt = if_not_exists(expiresAt, :exp)',
      ExpressionAttributeValues: { ':one': 1, ':exp': 1_800_000_180 },
      ReturnValues: 'UPDATED_NEW',
    });
  });

  it('returns the count after this request, which is what a limit is compared to', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { requestCount: 31, expiresAt: 1 } });

    expect(await adapter().incrementRateWindow(IP, 1_800_000_060, 1_800_000_180)).toBe(31);
  });

  it('refuses an instant DynamoDB TTL could not use, before sending anything', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { requestCount: 1 } });

    // Milliseconds are the classic version of this bug: DynamoDB silently never
    // expires a TTL that is not epoch *seconds*, so the table would grow for ever.
    await expect(adapter().incrementRateWindow(IP, 1_800_000_060, 1.8e12 + 0.5)).rejects.toThrow(
      /epoch seconds/,
    );
    await expect(adapter().incrementRateWindow(IP, -60, 1_800_000_180)).rejects.toThrow(
      /epoch seconds/,
    );
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('wraps a rejected update with the row it was counting', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('ThrottlingException'));

    const error = await captureStorageError(() =>
      adapter().incrementRateWindow(IP, 1_800_000_060, 1_800_000_180),
    );

    expect(error.context).toEqual({
      operation: 'incrementRateWindow',
      table: TABLE_NAME,
      key: { pk: 'RATE#203.0.113.7#1800000060' },
    });
  });
});

describe('getBlock', () => {
  it('reports a live block with the instant it runs out', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: `BLOCK#${IP}`, blockedUntil: NOW + 1 } });

    expect(await adapter().getBlock(IP)).toEqual({
      blocked: true,
      blockedUntilEpochSeconds: NOW + 1,
    });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { pk: 'BLOCK#203.0.113.7' },
    });
  });

  it('treats an expired row TTL has not yet collected as not blocked', async () => {
    // The row is still there — TTL deletion is best-effort and can lag by days.
    // Trusting its presence would turn a one-hour block into an indefinite one.
    ddbMock.on(GetCommand).resolves({ Item: { pk: `BLOCK#${IP}`, blockedUntil: NOW } });

    expect(await adapter().getBlock(IP)).toEqual({ blocked: false });
  });

  it('reports an address that was never blocked', async () => {
    ddbMock.on(GetCommand).resolves({});

    expect(await adapter().getBlock(IP)).toEqual({ blocked: false });
  });

  it('reads the real clock when none is injected', async () => {
    // Rule 7: every test above neutralises the clock, so the shipped default
    // needs one test of its own — a block a decade out is live under it, and
    // one from 1970 is not.
    const shipped = shippedAdapter();
    ddbMock.on(GetCommand).resolves({ Item: { blockedUntil: 2_100_000_000 } });
    expect(await shipped.getBlock(IP)).toEqual({
      blocked: true,
      blockedUntilEpochSeconds: 2_100_000_000,
    });

    ddbMock.on(GetCommand).resolves({ Item: { blockedUntil: 1 } });
    expect(await shipped.getBlock(IP)).toEqual({ blocked: false });
  });

  it('refuses a block row that carries no instant', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: `BLOCK#${IP}` } });

    await expect(adapter().getBlock(IP)).rejects.toThrow();
  });
});

describe('putBlock', () => {
  it('writes the block and its TTL as the same instant', async () => {
    ddbMock.on(PutCommand).resolves({});

    await adapter().putBlock(IP, NOW + 3600);

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Item: {
        pk: 'BLOCK#203.0.113.7',
        blockedUntil: NOW + 3600,
        expiresAt: NOW + 3600,
      },
    });
  });

  it('extends an existing block rather than reading it first', async () => {
    ddbMock.on(PutCommand).resolves({});

    await adapter().putBlock(IP, NOW + 60);
    await adapter().putBlock(IP, NOW + 3600);

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2);
  });

  it('wraps a rejected write with the row it was blocking', async () => {
    ddbMock.on(PutCommand).rejects(new Error('connection reset'));

    const error = await captureStorageError(() => adapter().putBlock(IP, NOW + 3600));

    expect(error.context).toEqual({
      operation: 'putBlock',
      table: TABLE_NAME,
      key: { pk: 'BLOCK#203.0.113.7' },
    });
  });
});

describe('read consistency', () => {
  it('never asks for a consistent read', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { requestCount: 1 } });
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    const abuse = adapter();

    await abuse.incrementRateWindow(IP, 1_800_000_060, 1_800_000_180);
    await abuse.getBlock(IP);
    await abuse.putBlock(IP, NOW + 3600);

    expect(ddbMock.calls()).toHaveLength(3);
    for (const call of ddbMock.calls()) {
      expect(call.args[0].input).not.toHaveProperty('ConsistentRead');
    }
  });
});
