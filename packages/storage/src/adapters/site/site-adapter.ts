import {
  TransactionCanceledException,
  TransactionConflictException,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { FleetSite, SitePhysics } from '@cumulo/shared';

import { StorageAdapterBase } from '../storage-adapter-base';

import {
  BY_LOCATION_INDEX,
  COUNTERS_SORT_KEY,
  FLEET_PARTITION,
  MIN_SITE_ID,
  USER_SITES_INDEX,
  USER_SITES_PARTITION,
  fromItem,
  toItem,
  toSitePhysics,
  toUserSiteId,
} from './site-item';

/**
 * The `cumulo-sites` adapter — the fleet control plane of ADR 0002 ("Key
 * design" table 1).
 *
 * The whole fleet lives in one partition (`pk = 'FLEET'`, sort key `siteId`) so
 * "list every site" (A2) and "enumerate active locations" (I1) are single
 * Queries rather than Scans. Two sparse GSIs hang off it, and *sparse* is the
 * load-bearing word: the index attributes are written only when the site
 * qualifies, so "inactive sites are invisible to the forecast service" and
 * "seed sites are never evicted" are properties of the data model rather than
 * of filters a later change could forget to apply. `site-item.ts` holds those
 * rules.
 *
 * `ConsistentRead` appears nowhere here (ADR 0002 Consequence 3) — see the
 * comment on `createStorageDocumentClient`.
 */

/** Outcome of a lookup by id. A site that does not exist is a value, not an error. */
export type GetFleetSiteResult =
  { readonly found: true; readonly site: FleetSite } | { readonly found: false };

/**
 * Outcome of a capped create (X1). A fleet already at its cap is an expected
 * domain outcome — the demo's whole point — so it is a value the caller must
 * handle, never an exception (`docs/standards/error-handling.md` rule 1).
 *
 * `conflict` is the other expected outcome: two concurrent creates contended on
 * the counter item and DynamoDB cancelled this one. Nothing is wrong and the
 * fleet may be nowhere near its cap — the caller simply lost a race and may try
 * again (see {@link conflictCancelled}).
 */
export type CreateUserSiteResult =
  { readonly created: true } | { readonly created: false; readonly reason: 'cap' | 'conflict' };

/** Outcome of the eviction lookup (X2). An empty user fleet is a value. */
export type OldestUserSiteResult =
  { readonly found: true; readonly siteId: string } | { readonly found: false };

/**
 * Outcome of an evict-and-create (X2). `oldest_gone` means another request
 * evicted the same site first — a lost race, which is ordinary under a public
 * write path and is reported so the caller can look up the new oldest and try
 * again. `conflict` is the other lost race: concurrent transactions contended
 * on one of these items and DynamoDB cancelled this one, saying nothing about
 * whether the oldest site is still there (see {@link conflictCancelled}).
 */
export type EvictAndCreateResult =
  | { readonly evicted: true }
  | { readonly evicted: false; readonly reason: 'oldest_gone' | 'conflict' };

/**
 * DynamoDB's cancellation code for a transaction item whose `ConditionExpression`
 * evaluated false. Every other code — `TransactionConflict`,
 * `ProvisionedThroughputExceeded`, `ThrottlingError`, `ValidationError` — means
 * the write did not happen for a reason that is *not* a domain outcome.
 */
const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailed';

/**
 * DynamoDB's cancellation code for a transaction item that collided with
 * another in-flight transaction on the same row — the counter item, in
 * practice, which every capped create and counted delete writes.
 */
const TRANSACTION_CONFLICT = 'TransactionConflict';

/** The code DynamoDB reports for an item that was itself fine. */
const NO_CANCELLATION_REASON = 'None';

/**
 * Was this rejection nothing but a lost race between concurrent transactions?
 *
 * Two shapes carry that answer. A standalone `TransactionConflictException` is
 * the whole request losing to an in-flight transaction; a
 * `TransactionCanceledException` whose reasons are `TransactionConflict` (plus
 * `None` for the items that were fine) is the same collision reported per item.
 *
 * The `every` clause is load-bearing, in the same way {@link cancelledOnlyBy}'s
 * "and by nothing else" is. A cancellation mixing `TransactionConflict` with a
 * `ConditionalCheckFailed` is not a bare race — a condition this adapter cares
 * about also failed, and the domain verdict has to win. A cancellation mixing
 * it with a capacity code (`ProvisionedThroughputExceeded`, `ThrottlingError`)
 * is not a bare race either: retrying that against a throttled table is the
 * thundering herd, and capacity classification is #166's decision to make, not
 * this predicate's. Both stay a `StorageError`.
 */
const conflictCancelled = (cause: unknown): boolean => {
  if (cause instanceof TransactionConflictException) {
    return true;
  }
  if (!(cause instanceof TransactionCanceledException)) {
    return false;
  }
  const reasons = cause.CancellationReasons ?? [];

  return (
    reasons.some((reason) => reason.Code === TRANSACTION_CONFLICT) &&
    reasons.every(
      (reason) => reason.Code === TRANSACTION_CONFLICT || reason.Code === NO_CANCELLATION_REASON,
    )
  );
};

/**
 * Was this rejection a transaction cancelled by the condition on item
 * `itemIndex`, and by nothing else?
 *
 * `TransactionCanceledException.CancellationReasons` is documented as ordered
 * to match the requested items, with `Code: 'None'` for items that were fine;
 * that ordering is the assumption this whole file rests on, so
 * `site-adapter.test.ts` pins it against the installed SDK rather than trusting
 * the doc string.
 *
 * "And by nothing else" is load-bearing. Each transaction below carries exactly
 * one condition whose failure is a *domain* answer; a second failed condition
 * in the same response means something the caller did not ask about went wrong
 * (a uuid that already exists), and that must not be reported as the domain
 * answer. A cancellation with no failed condition at all is likewise not *this*
 * answer: a pure conflict is {@link conflictCancelled}'s to classify, and a
 * capacity cancellation is nobody's — note that the SDK does **not** retry
 * `TransactionCanceledException` at all (`docs/tech-debt.md`), so a
 * capacity-cancelled transaction arrives here on its first and only attempt and
 * must surface as a `StorageError`, not as a full fleet.
 */
const cancelledOnlyBy = (cause: unknown, itemIndex: number): boolean => {
  if (!(cause instanceof TransactionCanceledException)) {
    return false;
  }
  const failed = (cause.CancellationReasons ?? []).flatMap((reason, index) =>
    reason.Code === CONDITIONAL_CHECK_FAILED ? [index] : [],
  );

  return failed.length === 1 && failed[0] === itemIndex;
};

/**
 * Guards the methods that may only be handed a user site.
 *
 * Passing a seed site to the eviction machinery would be a programming error
 * that quietly breaks the structural exemption the sparse `user-sites-by-age`
 * index exists to provide (a seed site written through the counter path would
 * inflate `userSiteCount` for ever), so it throws rather than returning a value
 * (`docs/standards/error-handling.md` rule 1).
 */
const requireUserOrigin = (operation: string, site: FleetSite): void => {
  if (site.origin !== 'user') {
    throw new Error(
      `${operation}: only a user site may be created through the cap; site ${site.id} is '${site.origin}'`,
    );
  }
};

const requirePositiveInteger = (operation: string, name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${operation}: ${name} must be a positive integer, got ${String(value)}`);
  }
};

/**
 * The items of a `TransactWriteItems`, as the *document* client types them
 * (native JavaScript values, not `AttributeValue` shapes).
 *
 * Derived from the command input rather than restated, so the array these
 * methods build is the array the SDK will accept, with no assertion in between.
 */
type SiteTransactItems = NonNullable<TransactWriteCommandInput['TransactItems']>;

/**
 * Item positions inside the transactions below. Named because the position *is*
 * the contract: `CancellationReasons` is indexed by it, so a reordered
 * `TransactItems` array with these left behind would silently start reading the
 * wrong item's verdict.
 */
const CAP_COUNTER_ITEM = 1;
const EVICTED_SITE_ITEM = 0;
const DELETED_SITE_ITEM = 0;

export class SiteAdapter extends StorageAdapterBase {
  /** Writes the whole item, index attributes included. Site *update* semantics are #14. */
  async putFleetSite(site: FleetSite): Promise<void> {
    await this.sending('putFleetSite', { pk: FLEET_PARTITION, siteId: site.id }, () =>
      this.client.send(new PutCommand({ TableName: this.tableName, Item: toItem(site) })),
    );
  }

  async getFleetSite(siteId: string): Promise<GetFleetSiteResult> {
    const output = await this.sending('getFleetSite', { pk: FLEET_PARTITION, siteId }, () =>
      this.client.send(
        new GetCommand({ TableName: this.tableName, Key: { pk: FLEET_PARTITION, siteId } }),
      ),
    );

    return output.Item === undefined
      ? { found: false }
      : { found: true, site: fromItem(output.Item) };
  }

  /** `deleted` is false when there was nothing to delete — idempotent, and says so. */
  async deleteFleetSite(siteId: string): Promise<{ deleted: boolean }> {
    const output = await this.sending('deleteFleetSite', { pk: FLEET_PARTITION, siteId }, () =>
      this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: FLEET_PARTITION, siteId },
          // The only way to know whether anything was there: DeleteItem is
          // idempotent and reports nothing by default, so without this the
          // 'deleted' answer would be a guess.
          ReturnValues: 'ALL_OLD',
        }),
      ),
    );

    return { deleted: output.Attributes !== undefined };
  }

  /**
   * Creates a user site only while the fleet is under `cap` user sites (X1).
   *
   * The site and the counter increment travel in one `TransactWriteItems`, so
   * the cap is enforced by DynamoDB rather than by a read-then-write that two
   * concurrent requests would both pass. The counter's condition —
   * `attribute_not_exists(userSiteCount) OR userSiteCount < :cap` — is what
   * rejects the 41st site, and its first arm is what lets an empty table serve
   * the first one without anybody seeding the counter item.
   *
   * The site's own `attribute_not_exists(siteId)` is not a cap check: it is the
   * guard that a create never overwrites an existing site, which would leave
   * the counter one ahead of reality for ever. Its failure is therefore *not* a
   * cap answer — see {@link cancelledOnlyBy}.
   */
  async createUserSiteWithCap(site: FleetSite, cap: number): Promise<CreateUserSiteResult> {
    requireUserOrigin('createUserSiteWithCap', site);
    requirePositiveInteger('createUserSiteWithCap', 'cap', cap);

    const outcome = await this.transactUnless(
      'createUserSiteWithCap',
      { pk: FLEET_PARTITION, siteId: site.id },
      CAP_COUNTER_ITEM,
      [
        {
          Put: {
            TableName: this.tableName,
            Item: toItem(site),
            ConditionExpression: 'attribute_not_exists(siteId)',
          },
        },
        {
          Update: {
            TableName: this.tableName,
            Key: { pk: FLEET_PARTITION, siteId: COUNTERS_SORT_KEY },
            UpdateExpression: 'ADD userSiteCount :one',
            ConditionExpression: 'attribute_not_exists(userSiteCount) OR userSiteCount < :cap',
            ExpressionAttributeValues: { ':one': 1, ':cap': cap },
          },
        },
      ],
    );

    switch (outcome) {
      case 'condition_failed':
        return { created: false, reason: 'cap' };
      case 'conflict':
        return { created: false, reason: 'conflict' };
      case 'written':
        return { created: true };
    }
  }

  /**
   * The user site that has been in the fleet longest — the eviction candidate
   * (X2).
   *
   * The `user-sites-by-age` index is sparse on `origin = 'user'`, so a seed
   * site cannot be returned here however old it is: "never evict a seed site"
   * is a property of what is in the index, not of a filter this query applies.
   * Ascending with `Limit: 1` reads exactly one item's worth of capacity.
   */
  async oldestUserSite(): Promise<OldestUserSiteResult> {
    const output = await this.sending('oldestUserSite', undefined, () =>
      this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: USER_SITES_INDEX,
          KeyConditionExpression: 'gsiUserSites = :user',
          ExpressionAttributeValues: { ':user': USER_SITES_PARTITION },
          // Oldest first: `gsiCreatedAt` is `<createdAt>#<siteId>`, so ascending
          // order is creation order, with the id breaking ties between sites
          // created in the same second.
          ScanIndexForward: true,
          Limit: 1,
        }),
      ),
    );

    const [item] = output.Items ?? [];

    return item === undefined ? { found: false } : { found: true, siteId: toUserSiteId(item) };
  }

  /**
   * Swaps the oldest user site for a new one in a single transaction (X2).
   *
   * The counter is deliberately untouched: one site leaves as one arrives, so
   * `userSiteCount` is already correct and an increment here would drift it
   * upward on every eviction. The delete's `attribute_exists(siteId)` is what
   * makes the swap safe under concurrency — if another request evicted the same
   * site first, the whole transaction is cancelled and *neither* half happened,
   * so the caller retries against the new oldest instead of creating a site
   * over the cap.
   */
  async evictAndCreateUserSite(
    evictSiteId: string,
    site: FleetSite,
  ): Promise<EvictAndCreateResult> {
    requireUserOrigin('evictAndCreateUserSite', site);

    const outcome = await this.transactUnless(
      'evictAndCreateUserSite',
      { pk: FLEET_PARTITION, siteId: evictSiteId },
      EVICTED_SITE_ITEM,
      [
        {
          Delete: {
            TableName: this.tableName,
            Key: { pk: FLEET_PARTITION, siteId: evictSiteId },
            ConditionExpression: 'attribute_exists(siteId)',
          },
        },
        { Put: { TableName: this.tableName, Item: toItem(site) } },
      ],
    );

    switch (outcome) {
      case 'condition_failed':
        return { evicted: false, reason: 'oldest_gone' };
      case 'conflict':
        return { evicted: false, reason: 'conflict' };
      case 'written':
        return { evicted: true };
    }
  }

  /**
   * Deletes a user site and decrements the counter in one transaction (X1).
   *
   * `attribute_exists(siteId)` is the anti-double-decrement guard: without it a
   * repeated delete would keep subtracting from `userSiteCount` and eventually
   * let the fleet grow past its cap. A transaction cancelled by that condition
   * means the site was already gone, so nothing was deleted *and* nothing was
   * decremented — reported as `{ deleted: false }`, the same idempotent answer
   * `deleteFleetSite` gives.
   */
  async deleteUserSiteWithCount(siteId: string): Promise<{ deleted: boolean }> {
    const outcome = await this.transactUnless(
      'deleteUserSiteWithCount',
      { pk: FLEET_PARTITION, siteId },
      DELETED_SITE_ITEM,
      [
        {
          Delete: {
            TableName: this.tableName,
            Key: { pk: FLEET_PARTITION, siteId },
            ConditionExpression: 'attribute_exists(siteId)',
          },
        },
        {
          Update: {
            TableName: this.tableName,
            Key: { pk: FLEET_PARTITION, siteId: COUNTERS_SORT_KEY },
            UpdateExpression: 'ADD userSiteCount :minusOne',
            ExpressionAttributeValues: { ':minusOne': -1 },
          },
        },
      ],
    );

    // INTERIM (#155 C1 → C3, same PR): this collapses `condition_failed` and
    // `conflict` into one falsy answer, so a caller cannot yet tell "already
    // gone" (a 404) from "lost a race" (worth retrying). C3 replaces this with
    // a `DeleteUserSiteResult` union and teaches the delete route to retry.
    // This mapping must not reach `main` on its own.
    return { deleted: outcome === 'written' };
  }

  /** Every site in the fleet, seed and user, active and inactive (A2, I1). */
  async listFleetSites(): Promise<FleetSite[]> {
    const items = await this.queryAllPages('listFleetSites', undefined, {
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :fleet AND siteId >= :minSiteId',
      ExpressionAttributeValues: { ':fleet': FLEET_PARTITION, ':minSiteId': MIN_SITE_ID },
    });

    return items.map(fromItem);
  }

  /** The physics parameters of every **active** site at a location (F1). */
  async listActiveSitePhysicsAtLocation(locationId: string): Promise<SitePhysics[]> {
    const items = await this.queryAllPages('listActiveSitePhysicsAtLocation', undefined, {
      TableName: this.tableName,
      IndexName: BY_LOCATION_INDEX,
      KeyConditionExpression: 'gsiLocation = :location',
      ExpressionAttributeValues: { ':location': locationId },
    });

    return items.map(toSitePhysics);
  }

  /**
   * Sends a conditional transaction and answers how it ended: it was `written`,
   * the condition on item `domainConditionItem` rejected it
   * (`condition_failed`), or concurrent writers contended for the same rows
   * (`conflict`).
   *
   * The three capped/counted writes above differ only in their items and in
   * which item carries the condition whose failure is a domain answer — same
   * intent, so the mechanism is shared rather than copied three times
   * (`docs/standards/structure.md` rule 7). What is *not* parameterised is what
   * counts as a domain answer: that stays two rules, in
   * {@link cancelledOnlyBy} and {@link conflictCancelled}. The condition is
   * checked **first**, so when a cancellation carries both verdicts the domain
   * answer wins.
   *
   * **This adapter never retries a conflict**, and that is a decision rather
   * than an omission. ADR 0002's layer-ownership rule (Amendments, #122) gives
   * each retry layer exactly one job, and the owner of a lost write race is the
   * API route handler: only it knows that "try again" means re-reading the
   * oldest site, and only it holds the request's overall time budget. Retrying
   * here would put a second, invisible curve underneath that one — the stacked
   * layers #122 pulled apart. Nor does the SDK layer cover this: verified
   * against `@aws-sdk/client-dynamodb` 3.1098.0, neither
   * `TransactionCanceledException` nor `TransactionConflictException` carries a
   * `$retryable` trait, and neither name appears in `@smithy/core` 3.31.1's
   * `THROTTLING_ERROR_CODES`/`TRANSIENT_ERROR_CODES` — so both shapes arrive
   * here on their first and only attempt.
   *
   * Anything else — a different item's condition, a capacity cancellation, a
   * connection reset — is rethrown untouched so that the surrounding `sending`
   * wraps it in a `StorageError`. That keeps the wrap in one place instead of
   * giving this package a second `StorageError` construction site whose context
   * could drift from the first.
   */
  private async transactUnless(
    operation: string,
    key: Record<string, string>,
    domainConditionItem: number,
    items: SiteTransactItems,
  ): Promise<'written' | 'condition_failed' | 'conflict'> {
    return this.sending(operation, key, async () => {
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: items }));
        return 'written';
      } catch (cause) {
        if (cancelledOnlyBy(cause, domainConditionItem)) {
          return 'condition_failed';
        }
        if (conflictCancelled(cause)) {
          return 'conflict';
        }
        throw cause;
      }
    });
  }
}
