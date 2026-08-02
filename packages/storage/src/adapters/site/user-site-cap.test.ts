import { QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it } from 'vitest';

import { captureStorageError } from '../storage-error-capture';

import {
  CONDITION_FAILED,
  NO_REASON,
  RANELAGH_ID,
  RATHMINES_ID,
  TABLE_NAME,
  TRANSACTION_CONFLICT,
  adapter,
  ddbMock,
  fleetSite,
  rathminesItem,
  transactionCancelled,
  transactionConflict,
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
    // The SDK does not retry TransactionCanceledException at all — pinned
    // empirically at the wire in `client-retry-classification.test.ts` — and
    // this adapter deliberately does not retry it either, so a throughput
    // cancellation arrives here on its first and only attempt. Answering 'cap'
    // would tell a caller the demo is full when the table is merely throttled.
    ddbMock
      .on(TransactWriteCommand)
      .rejects(transactionCancelled(NO_REASON, 'ProvisionedThroughputExceeded'));

    const error = await captureStorageError(() => adapter().createUserSiteWithCap(userSite, CAP));

    expect(error.context.operation).toBe('createUserSiteWithCap');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('reports a counter conflict as a lost race rather than a full fleet', async () => {
    // #155: concurrent capped creates contend on the single counter item, which
    // DynamoDB reports as a TransactionConflict cancellation. It says nothing
    // about how full the fleet is, so answering 'cap' would tell a caller the
    // demo is full when it merely lost a race — and leaving it unclassified is
    // what 500'd 8 of the 66 concurrent creates in #29's E2-a run.
    ddbMock.on(TransactWriteCommand).rejects(transactionCancelled(NO_REASON, TRANSACTION_CONFLICT));

    expect(await adapter().createUserSiteWithCap(userSite, CAP)).toEqual({
      created: false,
      reason: 'conflict',
    });
    // The adapter never retries: ADR 0002's layer-ownership rule puts the retry
    // on the route handler, which is the layer that knows what "try again"
    // means for the request.
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('reads a conflict from any item position, unlike the cap verdict', async () => {
    // The cap answer is position-dependent on purpose (see above), but a
    // conflict is not: whichever item collided, the whole transaction was
    // cancelled and nothing was written.
    ddbMock.on(TransactWriteCommand).rejects(transactionCancelled(TRANSACTION_CONFLICT, NO_REASON));

    expect(await adapter().createUserSiteWithCap(userSite, CAP)).toEqual({
      created: false,
      reason: 'conflict',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('reports a standalone TransactionConflictException as a lost race too', async () => {
    // The other shape the service uses: the whole request rejected, with no
    // per-item cancellation reasons at all.
    ddbMock.on(TransactWriteCommand).rejects(transactionConflict());

    expect(await adapter().createUserSiteWithCap(userSite, CAP)).toEqual({
      created: false,
      reason: 'conflict',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('does not call a conflict mixed with a failed condition a lost race', async () => {
    // Negative control for the classification's upper edge. Item 0's condition
    // guards against overwriting an existing id — a violated invariant. A
    // response carrying both that and a conflict is not a bare race, and
    // retrying it would re-run a write that must never succeed.
    ddbMock
      .on(TransactWriteCommand)
      .rejects(transactionCancelled(CONDITION_FAILED, TRANSACTION_CONFLICT));

    const error = await captureStorageError(() => adapter().createUserSiteWithCap(userSite, CAP));

    expect(error.context.operation).toBe('createUserSiteWithCap');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('lets the cap verdict beat a conflict on another item of the same transaction', async () => {
    // The mirror of the test above, and the shape the fleet actually produces:
    // the counter at index 1 is both the item the cap condition sits on and the
    // item concurrent creates collide over, so a cancellation naming a conflict
    // *and* the cap is reachable. The domain answer wins — the classification is
    // ordered, not a race between two predicates — because the fleet really is
    // full and re-issuing the create would only find it full again.
    ddbMock
      .on(TransactWriteCommand)
      .rejects(transactionCancelled(TRANSACTION_CONFLICT, CONDITION_FAILED));

    expect(await adapter().createUserSiteWithCap(userSite, CAP)).toEqual({
      created: false,
      reason: 'cap',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('does not read a cancellation that names no reason as a conflict', async () => {
    // Negative control for the classification's lower edge, and the reason
    // `conflictCancelled` asks whether *some* reason is a conflict before
    // asking whether *every* reason is one. Both of these are cancellations
    // that say nothing about why: with the `some` test gone, "every reason is
    // a conflict or None" is vacuously true for them and the adapter would
    // hand the route handler something to retry that it cannot explain.
    for (const rejection of [transactionCancelled(), transactionCancelled(NO_REASON, NO_REASON)]) {
      ddbMock.reset();
      ddbMock.on(TransactWriteCommand).rejects(rejection);

      const error = await captureStorageError(() => adapter().createUserSiteWithCap(userSite, CAP));

      expect(error.context.operation).toBe('createUserSiteWithCap');
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    }
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

  it('reports a conflicted eviction separately from a lost eviction race', async () => {
    // Both are lost races, but they call for different things: 'oldest_gone'
    // means look up the new oldest, a conflict means nothing about the oldest
    // site at all. Collapsing them would send the caller on a pointless query.
    ddbMock.on(TransactWriteCommand).rejects(transactionCancelled(TRANSACTION_CONFLICT, NO_REASON));

    expect(await adapter().evictAndCreateUserSite(RATHMINES_ID, userSite)).toEqual({
      evicted: false,
      reason: 'conflict',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
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

    expect(await adapter().deleteUserSiteWithCount(RATHMINES_ID)).toEqual({
      deleted: false,
      reason: 'already_gone',
    });
    // The decrement travelled *inside* the cancelled transaction, so it did not
    // happen either — and no compensating write was issued outside it.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(1);
  });

  it('reports a counter conflict as a lost race rather than a site already gone', async () => {
    // The delete writes the same counter item every capped create writes, so it
    // loses the same races. Answering 'already_gone' here would 404 a caller
    // whose site is still very much there — and would do it precisely when the
    // fleet is busiest.
    ddbMock.on(TransactWriteCommand).rejects(transactionCancelled(NO_REASON, TRANSACTION_CONFLICT));

    expect(await adapter().deleteUserSiteWithCount(RATHMINES_ID)).toEqual({
      deleted: false,
      reason: 'conflict',
    });
    // The retry belongs to the route handler (ADR 0002), so the adapter sends
    // exactly once whatever the answer.
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('reports a standalone TransactionConflictException on the delete path too', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionConflict());

    expect(await adapter().deleteUserSiteWithCount(RATHMINES_ID)).toEqual({
      deleted: false,
      reason: 'conflict',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
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
