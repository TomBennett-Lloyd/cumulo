import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { fleetSiteSchema, locationId, siteSchema, type FleetSite } from '@cumulo/shared';
import type { z } from 'zod';

import { StorageError } from './errors';

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
 * of filters a later change could forget to apply.
 *
 * `ConsistentRead` appears nowhere here (ADR 0002 Consequence 3) — see the
 * comment on `createStorageDocumentClient`.
 */

/** The literal partition key value shared by every site item. */
const FLEET_PARTITION = 'FLEET';

/** The literal partition key value of the `user-sites-by-age` index. */
const USER_SITES_PARTITION = 'USER';

/**
 * Lower bound of the site-id range in {@link SiteAdapter.listFleetSites}.
 *
 * Site ids are uuids, so they begin with a hex digit or a letter — all of which
 * sort at or after `'0'`. ADR 0002 also puts metadata in this partition at
 * `#META#…` sort keys (#29's counter item), and `'#'` (0x23) sorts *before*
 * `'0'` (0x30). So the range condition excludes non-site items structurally: a
 * future metadata item cannot leak into the fleet list and fail
 * `fleetSiteSchema.parse`, and nobody has to remember to filter it out.
 */
const MIN_SITE_ID = '0';

/** Mirrors the `by-location` index in `infra/storage/tables.tf`. */
const BY_LOCATION_INDEX = 'by-location';

/**
 * The physics parameters the forecast service reads for every active site at a
 * location (ADR 0002 access pattern F1).
 *
 * Derived by omission rather than redeclared, so the field definitions have one
 * home (`siteSchema`). The omitted field is exactly the one the `by-location`
 * index does not project — `name` — which is what makes this schema the
 * compile-time mirror of the INCLUDE projection in `infra/storage/tables.tf`.
 * If the projection changes, this line changes with it.
 */
const sitePhysicsSchema = siteSchema.omit({ name: true });

export type SitePhysics = z.infer<typeof sitePhysicsSchema>;

/**
 * A `cumulo-sites` item: the domain fields of a {@link FleetSite}, with `id`
 * renamed to the `siteId` key attribute, plus the computed key attributes.
 *
 * Key attributes are never domain fields (ADR 0002, architecture rule 2) — they
 * exist between `toItem` and `fromItem` and nowhere else.
 */
export type FleetSiteItem = Omit<FleetSite, 'id'> & {
  readonly pk: typeof FLEET_PARTITION;
  readonly siteId: string;
  readonly locationId: string;
  readonly gsiLocation?: string;
  readonly gsiUserSites?: typeof USER_SITES_PARTITION;
  readonly gsiCreatedAt?: string;
};

/**
 * Attributes that exist only to address the item. `fromItem` drops them so a
 * schema parse sees domain data alone, and so no key value can ever round-trip
 * back into the domain as if it were one.
 */
const KEY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'pk',
  'locationId',
  'gsiLocation',
  'gsiUserSites',
  'gsiCreatedAt',
]);

/**
 * Domain object → stored item.
 *
 * The sparseness rules, which are the reason this function exists rather than a
 * spread at each call site:
 *
 * - `gsiLocation` is written **only while `active === true`**, so deactivating a
 *   site removes it from the `by-location` index instead of leaving it there to
 *   be filtered out (F1).
 * - `gsiUserSites`/`gsiCreatedAt` are written **only for `origin === 'user'`**,
 *   regardless of `active` — an inactive user site is still a user site and
 *   still evictable (X2). The seed fleet is absent from `user-sites-by-age`
 *   entirely, which is how "never evict a seed site" becomes structural.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export function toItem(site: FleetSite): FleetSiteItem {
  const { id, ...domain } = site;
  const location = locationId(site);

  return {
    ...domain,
    pk: FLEET_PARTITION,
    siteId: id,
    locationId: location,
    ...(site.active ? { gsiLocation: location } : {}),
    ...(site.origin === 'user'
      ? { gsiUserSites: USER_SITES_PARTITION, gsiCreatedAt: `${site.createdAt}#${id}` }
      : {}),
  };
}

/** Strips the key attributes from a stored item, renaming `siteId` back to `id`. */
function domainAttributes(item: Record<string, unknown>): Record<string, unknown> {
  const domain: Record<string, unknown> = {};
  for (const [attribute, value] of Object.entries(item)) {
    if (attribute === 'siteId') {
      domain.id = value;
    } else if (!KEY_ATTRIBUTES.has(attribute)) {
      domain[attribute] = value;
    }
  }
  return domain;
}

/**
 * Stored item → domain object.
 *
 * The parse is not ceremony: a table is a boundary, so its contents are
 * `unknown` until a schema has looked at them (typing rule 3). An item that
 * does not parse means the table holds something this code did not write — a
 * violated invariant, so it throws rather than returning a value
 * (`docs/standards/error-handling.md` rule 1). Deliberately *not* wrapped in a
 * `StorageError`: that type means "the call to AWS failed", and labelling a
 * schema drift as an infrastructure failure would send the reader looking in
 * the wrong place.
 *
 * Exported for its tests; it is not part of the package's public surface.
 */
export function fromItem(item: Record<string, unknown>): FleetSite {
  return fleetSiteSchema.parse(domainAttributes(item));
}

/** A projected `by-location` index item → the physics parameters F1 needs. */
function toSitePhysics(item: Record<string, unknown>): SitePhysics {
  return sitePhysicsSchema.parse(domainAttributes(item));
}

/** Outcome of a lookup by id. A site that does not exist is a value, not an error. */
export type GetFleetSiteResult =
  { readonly found: true; readonly site: FleetSite } | { readonly found: false };

export interface SiteAdapter {
  /** Writes the whole item, index attributes included. Site *update* semantics are #14. */
  putFleetSite(site: FleetSite): Promise<void>;
  getFleetSite(siteId: string): Promise<GetFleetSiteResult>;
  /** `deleted` is false when there was nothing to delete — idempotent, and says so. */
  deleteFleetSite(siteId: string): Promise<{ deleted: boolean }>;
  /** Every site in the fleet, seed and user, active and inactive (A2, I1). */
  listFleetSites(): Promise<FleetSite[]>;
  /** The physics parameters of every **active** site at a location (F1). */
  listActiveSitePhysicsAtLocation(locationId: string): Promise<SitePhysics[]>;
}

export interface SiteAdapterDeps {
  readonly client: DynamoDBDocumentClient;
  /** Physical table name — build it with `storageTableName('sites', env)`. */
  readonly tableName: string;
}

export function createSiteAdapter(deps: SiteAdapterDeps): SiteAdapter {
  const { client, tableName } = deps;

  /**
   * Runs one SDK call and converts a rejection into a `StorageError` carrying
   * what was being attempted and on what (`error-handling.md` rules 2b and 4).
   *
   * Only the send is inside the `try`. Schema parsing happens on the way out,
   * so a drifted item keeps its own `ZodError` instead of being disguised as an
   * AWS failure.
   */
  async function sending<TResult>(
    operation: string,
    key: Record<string, string> | undefined,
    call: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await call();
    } catch (cause) {
      throw new StorageError(
        { operation, table: tableName, ...(key === undefined ? {} : { key }) },
        { cause },
      );
    }
  }

  /**
   * Runs a Query to exhaustion. DynamoDB pages at 1 MB regardless of how few
   * items that is in domain terms, so a caller that ignored `LastEvaluatedKey`
   * would silently return a prefix of the answer — the fleet list quietly
   * missing sites is precisely the kind of half-truth this codebase treats as a
   * failure, not an optimisation.
   */
  async function queryAllPages(
    operation: string,
    input: QueryCommandInput,
  ): Promise<Record<string, unknown>[]> {
    return sending(operation, undefined, async () => {
      const items: Record<string, unknown>[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;

      do {
        const page = await client.send(
          new QueryCommand({
            ...input,
            ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        items.push(...(page.Items ?? []));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);

      return items;
    });
  }

  return {
    async putFleetSite(site) {
      await sending('putFleetSite', { pk: FLEET_PARTITION, siteId: site.id }, () =>
        client.send(new PutCommand({ TableName: tableName, Item: toItem(site) })),
      );
    },

    async getFleetSite(siteId) {
      const output = await sending('getFleetSite', { pk: FLEET_PARTITION, siteId }, () =>
        client.send(new GetCommand({ TableName: tableName, Key: { pk: FLEET_PARTITION, siteId } })),
      );

      return output.Item === undefined
        ? { found: false }
        : { found: true, site: fromItem(output.Item) };
    },

    async deleteFleetSite(siteId) {
      const output = await sending('deleteFleetSite', { pk: FLEET_PARTITION, siteId }, () =>
        client.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { pk: FLEET_PARTITION, siteId },
            // The only way to know whether anything was there: DeleteItem is
            // idempotent and reports nothing by default, so without this the
            // 'deleted' answer would be a guess.
            ReturnValues: 'ALL_OLD',
          }),
        ),
      );

      return { deleted: output.Attributes !== undefined };
    },

    async listFleetSites() {
      const items = await queryAllPages('listFleetSites', {
        TableName: tableName,
        KeyConditionExpression: 'pk = :fleet AND siteId >= :minSiteId',
        ExpressionAttributeValues: { ':fleet': FLEET_PARTITION, ':minSiteId': MIN_SITE_ID },
      });

      return items.map(fromItem);
    },

    async listActiveSitePhysicsAtLocation(locationId) {
      const items = await queryAllPages('listActiveSitePhysicsAtLocation', {
        TableName: tableName,
        IndexName: BY_LOCATION_INDEX,
        KeyConditionExpression: 'gsiLocation = :location',
        ExpressionAttributeValues: { ':location': locationId },
      });

      return items.map(toSitePhysics);
    },
  };
}
