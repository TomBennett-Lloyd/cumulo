import { equal, ok } from 'node:assert/strict';

import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, NativeAttributeValue } from '@aws-sdk/lib-dynamodb';
import { archiveDayMarkerSortKey, locationId, seriesSortKey, weatherSortKey } from '@cumulo/shared';

import { SiteAdapter, storageTableName } from '../../src/index';

import { eventually, type CheckRunner } from './check-runner';
import { ENVIRONMENT, HOUR_0, HOUR_1, SMOKE_DAY, SMOKE_LOCATION } from './smoke-data';

/**
 * Counts every item in one partition, straight through the document client.
 *
 * Deliberately *not* an adapter call: this is the residue check, and its whole
 * job is to see anything the adapters would not surface — an item under a sort
 * key no adapter queries, a marker left by a half-finished transaction. An
 * adapter-shaped read would only find what the adapters already know to look
 * for, which is exactly the wrong instrument for "is there anything left?".
 */
const countPartitionItems = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  partitionAttribute: string,
  partitionValue: string,
): Promise<number> => {
  let count = 0;
  let cursor: Record<string, NativeAttributeValue> | undefined;

  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#pk = :pk',
        // The attribute name is a variable here (`siteId` or `locationId`), so
        // it goes through a placeholder rather than string-concatenation.
        ExpressionAttributeNames: { '#pk': partitionAttribute },
        ExpressionAttributeValues: { ':pk': partitionValue },
        Select: 'COUNT',
        ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
      }),
    );
    count += page.Count ?? 0;
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);

  return count;
};

/**
 * Deletes one item by key, straight through the document client.
 *
 * Neither the series nor the weather adapter offers a delete: range deletion
 * and eviction are #29's scope, and inventing a public delete here to make the
 * script tidy would be shipping API surface nobody asked for. So teardown
 * addresses items directly — but it builds their keys with the same
 * `@cumulo/shared` key functions the adapters write them with, so a key-format
 * change cannot leave this script deleting the wrong thing (or nothing).
 */
const deleteItem = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  key: Record<string, string>,
): Promise<void> => {
  await client.send(new DeleteCommand({ TableName: tableName, Key: key }));
};

/**
 * Removes everything the checks wrote, then proves it. Runs whatever happened
 * above — a run that failed halfway is exactly the run most likely to have left
 * items behind.
 */
export const runTeardown = async (
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
  siteId: string,
): Promise<void> => {
  const sitesTable = storageTableName('sites', ENVIRONMENT);
  const seriesTable = storageTableName('series', ENVIRONMENT);
  const weatherTable = storageTableName('weather', ENVIRONMENT);
  const sites = new SiteAdapter({ client, tableName: sitesTable });
  const partitionKey = locationId(SMOKE_LOCATION);

  await runner.check('cleanup: the site is deleted and no longer readable', async () => {
    const { deleted } = await sites.deleteFleetSite(siteId);
    ok(deleted, 'deleteFleetSite reported nothing to delete');
    const result = await eventually(
      'cleanup: the deleted site is gone',
      () => sites.getFleetSite(siteId),
      (found) => !found.found,
    );
    ok(!result.found, 'the site is still readable after deletion');
  });

  await runner.check('cleanup: the site left the by-location index', async () => {
    await eventually(
      'cleanup: the by-location index no longer lists the site',
      () => sites.listActiveSitePhysicsAtLocation(partitionKey),
      (found) => !found.some((entry) => entry.id === siteId),
    );
  });

  await runner.check('cleanup: the series partition is empty', async () => {
    for (const sortKey of [
      seriesSortKey(HOUR_0, { kind: 'forecast', model: 'physics' }),
      seriesSortKey(HOUR_0, { kind: 'forecast', model: 'ml' }),
      seriesSortKey(HOUR_1, { kind: 'generation' }),
    ]) {
      await deleteItem(client, seriesTable, { siteId, sk: sortKey });
    }
    const remaining = await eventually(
      'cleanup: the series partition drained',
      () => countPartitionItems(client, seriesTable, 'siteId', siteId),
      (count) => count === 0,
    );
    equal(remaining, 0, 'series items survived cleanup');
  });

  await runner.check('cleanup: the weather partition is empty', async () => {
    for (const sortKey of [
      weatherSortKey('archive', HOUR_0),
      weatherSortKey('archive', HOUR_1),
      weatherSortKey('forecast', HOUR_0),
      archiveDayMarkerSortKey(SMOKE_DAY),
    ]) {
      await deleteItem(client, weatherTable, { locationId: partitionKey, sk: sortKey });
    }
    const remaining = await eventually(
      'cleanup: the weather partition drained',
      () => countPartitionItems(client, weatherTable, 'locationId', partitionKey),
      (count) => count === 0,
    );
    equal(remaining, 0, 'weather items survived cleanup');
  });
};
