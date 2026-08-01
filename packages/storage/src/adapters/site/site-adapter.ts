import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { FleetSite, SitePhysics } from '@cumulo/shared';

import { StorageAdapterBase } from '../storage-adapter-base';

import {
  BY_LOCATION_INDEX,
  FLEET_PARTITION,
  MIN_SITE_ID,
  fromItem,
  toItem,
  toSitePhysics,
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
}
