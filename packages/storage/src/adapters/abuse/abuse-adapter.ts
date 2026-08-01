import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { StorageAdapterBase, type StorageAdapterDeps } from '../storage-adapter-base';

import { blockKey, rateWindowKey, toBlockItem, toBlockedUntil, toRequestCount } from './abuse-item';

/**
 * The `cumulo-abuse` adapter — the state behind the per-IP request limiter on
 * the public write path (#29).
 *
 * It is the one table in this repo that exists because the API is anonymous:
 * an HTTP API has no usage plans and no API keys (a REST-API feature), and WAF
 * cannot attach to one at all, so per-address limiting is application state.
 * On-demand billing, and TTL on every row, is what keeps that decision free —
 * see `infra/storage/tables.tf`.
 *
 * This adapter deliberately holds **no policy**. How many requests a window
 * allows, how long a window is, how long a block lasts and when to cache a
 * verdict are all the limiter's (`apps/api`), because those numbers are what a
 * reader tunes and they belong next to the route they defend. What lives here
 * is only the storage: increment a counter, read a block, write a block.
 *
 * `ConsistentRead` appears nowhere here (ADR 0002 Consequence 3) — see the
 * comment on `createStorageDocumentClient`. It matters least on this table: a
 * limiter that occasionally reads a block a moment late admits one more
 * request, which is well inside the tolerance a fixed-window limiter already
 * has.
 */

/** Epoch seconds, because DynamoDB TTL is defined in seconds and nothing else. */
const nowEpochSeconds = (): number => Math.floor(Date.now() / 1000);

export interface AbuseAdapterDeps extends StorageAdapterDeps {
  /**
   * Injectable for tests; production leaves it unset and gets the real clock.
   *
   * A clock is a dependency rather than a `Date.now()` call in the middle of
   * `getBlock` because the *decision* it feeds — has this block expired? — is
   * the interesting behaviour, and a test should be able to stand either side
   * of the instant without waiting for it.
   */
  readonly nowEpochSeconds?: () => number;
}

/**
 * Whether an address is currently blocked, and until when.
 *
 * A block that has run out is reported as *not blocked* rather than as a block
 * in the past, so no caller has to remember to compare it to a clock — see
 * {@link AbuseAdapter.getBlock}.
 */
export type BlockStatus =
  | { readonly blocked: true; readonly blockedUntilEpochSeconds: number }
  | { readonly blocked: false };

const requireEpochSeconds = (operation: string, name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${operation}: ${name} must be a non-negative integer of epoch seconds, got ${String(value)}`,
    );
  }
};

export class AbuseAdapter extends StorageAdapterBase {
  private readonly now: () => number;

  constructor(deps: AbuseAdapterDeps) {
    super(deps);
    this.now = deps.nowEpochSeconds ?? nowEpochSeconds;
  }

  /**
   * Counts one request against an address's window and returns the new count.
   *
   * `ADD` is an atomic counter, so concurrent requests from one address cannot
   * lose an increment between a read and a write — which is the only reason
   * this is a limiter rather than an estimate. The post-increment value comes
   * back on the same round trip (`UPDATED_NEW`), so deciding "over the limit"
   * costs one call rather than a write plus a read.
   *
   * `expiresAt` is written with `if_not_exists`, so the first request in a
   * window sets the row's lifetime and later ones never push it out: a busy
   * address cannot keep its own counter alive past the window it belongs to.
   * The caller chooses that instant, and should leave slack past the window's
   * end — TTL deletion is asynchronous, and a row reaped *early* would silently
   * reset a window mid-flight.
   */
  async incrementRateWindow(
    ip: string,
    windowStartEpochSeconds: number,
    expiresAtEpochSeconds: number,
  ): Promise<number> {
    requireEpochSeconds('incrementRateWindow', 'windowStartEpochSeconds', windowStartEpochSeconds);
    requireEpochSeconds('incrementRateWindow', 'expiresAtEpochSeconds', expiresAtEpochSeconds);
    const pk = rateWindowKey(ip, windowStartEpochSeconds);

    const output = await this.sending('incrementRateWindow', { pk }, () =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk },
          UpdateExpression: 'ADD requestCount :one SET expiresAt = if_not_exists(expiresAt, :exp)',
          ExpressionAttributeValues: { ':one': 1, ':exp': expiresAtEpochSeconds },
          ReturnValues: 'UPDATED_NEW',
        }),
      ),
    );

    return toRequestCount(output.Attributes);
  }

  /**
   * Whether an address is blocked right now.
   *
   * A row whose `blockedUntil` has passed but which TTL has not yet collected
   * is reported as **not blocked**. That is the whole reason this method owns a
   * clock: DynamoDB's TTL deletion is best-effort and typically lands within
   * days, not seconds, so "the row is still there" is not the same fact as "the
   * block is still in force". Trusting presence alone would turn a one-hour
   * block into an indefinite one, which on an anonymous demo means a visitor
   * behind a shared NAT locked out for as long as DynamoDB felt like it.
   */
  async getBlock(ip: string): Promise<BlockStatus> {
    const pk = blockKey(ip);

    const output = await this.sending('getBlock', { pk }, () =>
      this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk } })),
    );

    if (output.Item === undefined) {
      return { blocked: false };
    }
    const blockedUntilEpochSeconds = toBlockedUntil(output.Item);

    return blockedUntilEpochSeconds > this.now()
      ? { blocked: true, blockedUntilEpochSeconds }
      : { blocked: false };
  }

  /**
   * Blocks an address until an instant.
   *
   * A plain overwrite: re-blocking an already-blocked address extends the block
   * to the new instant, which is what a client still hammering the limiter has
   * earned. There is nothing to read first and therefore no race to lose.
   */
  async putBlock(ip: string, blockedUntilEpochSeconds: number): Promise<void> {
    requireEpochSeconds('putBlock', 'blockedUntilEpochSeconds', blockedUntilEpochSeconds);
    const item = toBlockItem(ip, blockedUntilEpochSeconds);

    await this.sending('putBlock', { pk: item.pk }, () =>
      this.client.send(new PutCommand({ TableName: this.tableName, Item: item })),
    );
  }
}
