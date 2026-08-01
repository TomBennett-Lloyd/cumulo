import { fleetSiteSchema, locationId, siteSchema, type FleetSite } from '@cumulo/shared';
import { z } from 'zod';

/**
 * The wire format of a `cumulo-sites` item: the key attributes ADR 0002's
 * "Key design" table 1 puts around a {@link FleetSite}, and the two functions
 * that add and remove them.
 *
 * These live apart from the adapter because they are the part a reader checks
 * against the ADR and against `infra/storage/tables.tf` — the sparseness rules
 * especially — while the adapter is about which command carries them.
 */

/** The literal partition key value shared by every site item. */
export const FLEET_PARTITION = 'FLEET';

/** The literal partition key value of the `user-sites-by-age` index. */
export const USER_SITES_PARTITION = 'USER';

/**
 * The sort key of the fleet's counter item — ADR 0002's `#META#counters` row,
 * which holds `userSiteCount` and is the item #29's cap transaction conditions
 * on.
 *
 * It shares the `FLEET` partition with the sites it counts, which is the whole
 * point: a `TransactWriteItems` can then hold both the new site and the
 * increment, so "40 user sites" is an invariant DynamoDB enforces rather than
 * one a read-then-write hopes for.
 */
export const COUNTERS_SORT_KEY = '#META#counters';

/**
 * Lower bound of the site-id range in `SiteAdapter.listFleetSites`.
 *
 * Site ids are uuids, so they begin with a hex digit or a letter — all of which
 * sort at or after `'0'`. ADR 0002 also puts metadata in this partition at
 * `#META#…` sort keys — since #29 that is {@link COUNTERS_SORT_KEY}, a real
 * item rather than a hypothetical one — and `'#'` (0x23) sorts *before* `'0'`
 * (0x30). So the range condition excludes non-site items structurally: the
 * counter cannot leak into the fleet list and fail `fleetSiteSchema.parse`, and
 * nobody has to remember to filter it out.
 */
export const MIN_SITE_ID = '0';

/** Mirrors the `by-location` index in `infra/storage/tables.tf`. */
export const BY_LOCATION_INDEX = 'by-location';

/** Mirrors the `user-sites-by-age` index in `infra/storage/tables.tf`. */
export const USER_SITES_INDEX = 'user-sites-by-age';

/**
 * What a `user-sites-by-age` hit yields once parsed: the base-table site id.
 *
 * The index is KEYS_ONLY, so DynamoDB projects the table keys (`pk`, `siteId`)
 * alongside the index keys and nothing else — which is exactly what eviction
 * needs, an id rather than a site. Parsed rather than trusted because an index
 * response is as much a boundary as a table read is (typing rule 3), and an
 * item without a `siteId` would otherwise become an eviction addressed at
 * `undefined`.
 */
const userSiteKeySchema = z.object({ siteId: z.string().min(1) });

/** A projected `user-sites-by-age` item → the id of the site it points at. */
export const toUserSiteId = (item: Record<string, unknown>): string =>
  userSiteKeySchema.parse(item).siteId;

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
export const toItem = (site: FleetSite): FleetSiteItem => {
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
};

/** Strips the key attributes from a stored item, renaming `siteId` back to `id`. */
const domainAttributes = (item: Record<string, unknown>): Record<string, unknown> => {
  const domain: Record<string, unknown> = {};
  for (const [attribute, value] of Object.entries(item)) {
    if (attribute === 'siteId') {
      domain.id = value;
    } else if (!KEY_ATTRIBUTES.has(attribute)) {
      domain[attribute] = value;
    }
  }
  return domain;
};

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
export const fromItem = (item: Record<string, unknown>): FleetSite =>
  fleetSiteSchema.parse(domainAttributes(item));

/** A projected `by-location` index item → the physics parameters F1 needs. */
export const toSitePhysics = (item: Record<string, unknown>): SitePhysics =>
  sitePhysicsSchema.parse(domainAttributes(item));
