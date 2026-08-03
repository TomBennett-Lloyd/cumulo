import { deepStrictEqual, equal, ok } from 'node:assert/strict';

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, NativeAttributeValue } from '@aws-sdk/lib-dynamodb';

import { AbuseAdapter, storageTableName } from '../../src/index';
// Reached past `index.ts` by relative path, exactly as `teardown.ts` reaches for
// the shared key functions: these checks address rows the adapter wrote, so they
// build the keys with the very functions it wrote them with. A key-format change
// then breaks the adapter and this script together instead of leaving the script
// quietly reading the wrong `pk`. Exporting them on the package surface to serve
// an in-package script would widen a deliberate promise for nothing.
import { blockKey, rateWindowKey } from '../../src/adapters/abuse/abuse-item';
import { ENVIRONMENT } from '../storage-environment';

import { eventually, type CheckRunner } from './check-runner';
import { SMOKE_RATE_WINDOW_START_EPOCH_SECONDS, smokeAbuseAddress } from './smoke-data';
import { assertTtlStatus } from './ttl-status';

/** How long past `now` the first increment pins its window's expiry. */
const RATE_WINDOW_TTL_SECONDS = 900;

/** A second, deliberately longer expiry the second increment must fail to install. */
const EXTENDED_TTL_SECONDS = 9999;

const BLOCK_DURATION_SECONDS = 3600;

/** How far in the past the expired-block row is dated. */
const EXPIRED_BLOCK_AGE_SECONDS = 60;

/**
 * Reads one abuse row straight through the document client.
 *
 * Deliberately not an adapter call. Two of the checks below are about what is
 * *stored* — the expiry the first increment pinned, and a block row that
 * outlived the instant it names — while the adapter's own readers answer
 * different questions (the running count, the current verdict). Only a raw read
 * can tell "the row says X" apart from "the adapter concluded X", and telling
 * those apart is the whole point of the expired-block check.
 */
const readAbuseRow = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
): Promise<Record<string, NativeAttributeValue> | undefined> => {
  const output = await client.send(new GetCommand({ TableName: tableName, Key: { pk } }));

  return output.Item;
};

/** The `cumulo-abuse` checks: the atomic counter, the pinned expiry, the block verdict, TTL. */
export const runAbuseChecks = async (
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
  siteId: string,
): Promise<void> => {
  const abuseTable = storageTableName('abuse', ENVIRONMENT);
  const abuse = new AbuseAdapter({ client, tableName: abuseTable });
  const address = smokeAbuseAddress(siteId);
  const rateRowKey = rateWindowKey(address, SMOKE_RATE_WINDOW_START_EPOCH_SECONDS);
  // One instant for the whole module. Every expiry below is asserted against the
  // exact number that was written, so a clock read twice could fail a check that
  // is about DynamoDB rather than about time passing.
  const now = Math.floor(Date.now() / 1000);

  await runner.check(
    'abuse: incrementRateWindow counts atomically and returns the running count',
    async () => {
      const first = await abuse.incrementRateWindow(
        address,
        SMOKE_RATE_WINDOW_START_EPOCH_SECONDS,
        now + RATE_WINDOW_TTL_SECONDS,
      );
      equal(first, 1, 'the first increment of a fresh window did not return 1');
      // `UPDATED_NEW` on an `ADD` — the post-increment value on the same round
      // trip. A mock can prove we asked for it; only the service proves it
      // counts rather than overwrites.
      const second = await abuse.incrementRateWindow(
        address,
        SMOKE_RATE_WINDOW_START_EPOCH_SECONDS,
        now + EXTENDED_TTL_SECONDS,
      );
      equal(second, 2, 'the second increment did not return 2 — the counter is not accumulating');
    },
  );

  await runner.check(
    'abuse: the first increment fixes expiresAt and a later one cannot extend it',
    async () => {
      const row = await eventually(
        'abuse: the rate-window row shows both increments',
        () => readAbuseRow(client, abuseTable, rateRowKey),
        (found) => found?.requestCount === 2,
      );
      ok(row !== undefined, 'the rate-window row was never readable');
      // The precondition, asserted here rather than assumed. What makes the
      // expiry below meaningful is that a *second* increment ran and asked for a
      // later one; that increment happens in the check above, and `CheckRunner`
      // catches per check, so a run where it failed would still reach this one —
      // and a row still holding the first write's count and the first write's
      // expiry would pass an expiry-only assertion while proving nothing.
      equal(
        row.requestCount,
        2,
        'the row does not show the second increment, so the expiry proves nothing',
      );
      // `if_not_exists` proven live: the second increment asked for
      // `now + 9999` and must have lost. If it had won, a busy address could
      // keep its own counter alive past the window it belongs to, and the
      // limiter would silently stop being a fixed-window limiter.
      equal(
        row.expiresAt,
        now + RATE_WINDOW_TTL_SECONDS,
        'a later increment moved the expiry the first one pinned',
      );
    },
  );

  await runner.check(
    'abuse: putBlock then getBlock reports the block and its instant',
    async () => {
      await abuse.putBlock(address, now + BLOCK_DURATION_SECONDS);
      const status = await eventually(
        'abuse: the block is readable',
        () => abuse.getBlock(address),
        (found) => found.blocked,
      );
      ok(status.blocked, 'expected the address to be blocked');
      equal(
        status.blockedUntilEpochSeconds,
        now + BLOCK_DURATION_SECONDS,
        'the block instant read back is not the one written',
      );
    },
  );

  await runner.check(
    'abuse: an expired block row reports not blocked while the row still survives TTL lag',
    async () => {
      await abuse.putBlock(address, now - EXPIRED_BLOCK_AGE_SECONDS);
      // The row has to be *demonstrably present* carrying the expired instant
      // before the verdict is read. Reading the verdict first would let a
      // `blocked: false` mean "TTL already collected the row", which proves
      // nothing about the clock comparison this check exists to prove — TTL
      // reaping is days, not seconds, so presence is the realistic state and
      // the adapter must handle it. Do not reorder these two steps.
      const row = await eventually(
        'abuse: the overwritten block row shows the expired instant',
        () => readAbuseRow(client, abuseTable, blockKey(address)),
        (found) => found?.blockedUntil === now - EXPIRED_BLOCK_AGE_SECONDS,
      );
      ok(row !== undefined, 'the expired block row is not present, so the verdict proves nothing');
      const status = await abuse.getBlock(address);
      deepStrictEqual(
        status,
        { blocked: false },
        'a block whose instant has passed still reports as blocking',
      );
    },
  );

  await runner.check('abuse: TTL is ENABLED on the expiresAt attribute', async () => {
    await assertTtlStatus(client, abuseTable, 'ENABLED');
  });
};
