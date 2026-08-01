import { QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it } from 'vitest';

import { captureStorageError } from '../storage-error-capture';

import {
  CONDITION_FAILED,
  NO_REASON,
  RANELAGH_ID,
  RATHMINES_ID,
  TABLE_NAME,
  adapter,
  ddbMock,
  fleetSite,
  rathminesItem,
  transactionCancelled,
} from './site-fixtures';
import { toItem } from './site-item';

/**
 * The site cap and its eviction (ADR 0002 X1/X2), which are the only writes in
 * this package whose *correctness* depends on a transaction: a cap enforced by
 * a read-then-write would admit the 41st site under concurrency, and an
 * eviction that deleted before it created could lose a site outright.
 *
 * Contract tests in the sense `docs/standards/testing.md` rule 3 means — every
 * assertion is on the command input this adapter would put on the wire, or on
 * the domain value it derives from a DynamoDB-shaped rejection. The rejections
 * are built from the SDK's own `TransactionCanceledException`
 * (`transactionCancelled` in the fixtures) because the *ordering* of
 * `CancellationReasons` is the assumption the cap logic rests on: these tests
 * are what pins it against the installed SDK rather than against its doc string.
 */

const userSite = fleetSite({ origin: 'user' });
const CAP = 40;

const transactItems = (): unknown[] => {
  const [call] = ddbMock.commandCalls(TransactWriteCommand);
  if (call === undefined) {
    throw new Error('expected one TransactWriteCommand');
  }
  return call.args[0].input.TransactItems ?? [];
};

beforeEach(() => {
  ddbMock.reset();
});

describe('createUserSiteWithCap', () => {
  it('puts the site and increments the counter in one capped transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    expect(await adapter().createUserSiteWithCap(userSite, CAP)).toEqual({ created: true });
    expect(transactItems()).toEqual([
      {
        Put: {
          TableName: TABLE_NAME,
          Item: toItem(userSite),
          ConditionExpression: 'attribute_not_exists(siteId)',
        },
      },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: { pk: 'FLEET', siteId: '#META#counters' },
          UpdateExpression: 'ADD userSiteCount :one',
          ConditionExpression: 'attribute_not_exists(userSiteCount) OR userSiteCount < :cap',
          ExpressionAttributeValues: { ':one': 1, ':cap': CAP },
        },
      },
    ]);
  });

  it('reports a full fleet as a value rather than an error', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCancelled(NO_REASON, CONDITION_FAILED));

    expect(await adapter().createUserSiteWithCap(userSite, CAP)).toEqual({
      created: false,
      reason: 'cap',
    });
  });

  it('reads the verdict by item position, so a failed put is not a full fleet', async () => {
    // The assumption under test: `CancellationReasons` is ordered to match the
    // requested items. Item 0 is the site put, whose condition guards against
    // overwriting an existing id — a violated invariant, not a cap. Were the
    // adapter to scan for *any* ConditionalCheckFailed it would answer 'cap'
    // here, and a colliding id would silently look like a full fleet.
    ddbMock.on(TransactWriteCommand).rejects(transactionCancelled(CONDITION_FAILED, NO_REASON));

    const error = await captureStorageError(() => adapter().createUserSiteWithCap(userSite, CAP));

    expect(error.context).toEqual({
      operation: 'createUserSiteWithCap',
      table: TABLE_NAME,
      key: { pk: 'FLEET', siteId: RANELAGH_ID },
    });
  });

  it('does not mistake a capacity cancellation for a full fleet', async () => {
    // The SDK does not retry TransactionCanceledException at all
    // (docs/tech-debt.md), so a throughput cancellation arrives here on its
    // first and only attempt. Answering 'cap' would tell a caller the demo is
    // full when the table is merely throttled.
    ddbMock
      .on(TransactWriteCommand)
      .rejects(transactionCancelled(NO_REASON, 'ProvisionedThroughputExceeded'));

    const error = await captureStorageError(() => adapter().createUserSiteWithCap(userSite, CAP));

    expect(error.context.operation).toBe('createUserSiteWithCap');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('wraps an ordinary transport rejection in a StorageError', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('connection reset'));

    const error = await captureStorageError(() => adapter().createUserSiteWithCap(userSite, CAP));

    expect(error.context.operation).toBe('createUserSiteWithCap');
  });

  it('refuses to run a seed site through the counter, before sending anything', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      adapter().createUserSiteWithCap(fleetSite({ origin: 'seed' }), CAP),
    ).rejects.toThrow(/only a user site/);
    await expect(adapter().createUserSiteWithCap(userSite, 0)).rejects.toThrow(
      /cap must be a positive integer/,
    );
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

describe('oldestUserSite', () => {
  it('reads the sparse user index ascending, one item deep', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ siteId: RATHMINES_ID }] });

    expect(await adapter().oldestUserSite()).toEqual({ found: true, siteId: RATHMINES_ID });
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      IndexName: 'user-sites-by-age',
      KeyConditionExpression: 'gsiUserSites = :user',
      ExpressionAttributeValues: { ':user': 'USER' },
      ScanIndexForward: true,
      Limit: 1,
    });
  });

  it('reports an empty user fleet as a value', async () => {
    ddbMock.on(QueryCommand).resolves({});

    expect(await adapter().oldestUserSite()).toEqual({ found: false });
  });

  it('refuses an index hit that carries no site id, rather than evicting undefined', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ gsiUserSites: 'USER' }] });

    await expect(adapter().oldestUserSite()).rejects.toThrow();
  });
});

describe('evictAndCreateUserSite', () => {
  it('swaps the two sites atomically and leaves the counter alone', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    expect(await adapter().evictAndCreateUserSite(RATHMINES_ID, userSite)).toEqual({
      evicted: true,
    });
    expect(transactItems()).toEqual([
      {
        Delete: {
          TableName: TABLE_NAME,
          Key: { pk: 'FLEET', siteId: RATHMINES_ID },
          ConditionExpression: 'attribute_exists(siteId)',
        },
      },
      { Put: { TableName: TABLE_NAME, Item: toItem(userSite) } },
    ]);
    // One site out, one in: the count is unchanged, so touching the counter
    // here would drift it upward on every eviction.
    expect(JSON.stringify(transactItems())).not.toContain('userSiteCount');
  });

  it('reports a lost eviction race instead of creating a site over the cap', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCancelled(CONDITION_FAILED, NO_REASON));

    expect(await adapter().evictAndCreateUserSite(RATHMINES_ID, userSite)).toEqual({
      evicted: false,
      reason: 'oldest_gone',
    });
  });

  it('refuses to create a seed site through the eviction path', async () => {
    await expect(
      adapter().evictAndCreateUserSite(RATHMINES_ID, fleetSite({ origin: 'seed' })),
    ).rejects.toThrow(/only a user site/);
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

describe('deleteUserSiteWithCount', () => {
  it('deletes and decrements in one transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    expect(await adapter().deleteUserSiteWithCount(RATHMINES_ID)).toEqual({ deleted: true });
    expect(transactItems()).toEqual([
      {
        Delete: {
          TableName: TABLE_NAME,
          Key: { pk: 'FLEET', siteId: RATHMINES_ID },
          ConditionExpression: 'attribute_exists(siteId)',
        },
      },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: { pk: 'FLEET', siteId: '#META#counters' },
          UpdateExpression: 'ADD userSiteCount :minusOne',
          ExpressionAttributeValues: { ':minusOne': -1 },
        },
      },
    ]);
  });

  it('never decrements for a site that was already gone', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCancelled(CONDITION_FAILED, NO_REASON));

    expect(await adapter().deleteUserSiteWithCount(RATHMINES_ID)).toEqual({ deleted: false });
    // The decrement travelled *inside* the cancelled transaction, so it did not
    // happen either — and no compensating write was issued outside it.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(1);
  });
});

describe('read consistency', () => {
  it('never asks for a consistent read on the capped paths', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [{ siteId: RATHMINES_ID }] });
    const sites = adapter();

    await sites.createUserSiteWithCap(userSite, CAP);
    await sites.oldestUserSite();
    await sites.evictAndCreateUserSite(RATHMINES_ID, userSite);
    await sites.deleteUserSiteWithCount(rathminesItem.siteId);

    expect(ddbMock.calls()).toHaveLength(4);
    for (const call of ddbMock.calls()) {
      expect(call.args[0].input).not.toHaveProperty('ConsistentRead');
    }
  });
});
