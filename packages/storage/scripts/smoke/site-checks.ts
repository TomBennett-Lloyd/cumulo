import { deepStrictEqual, ok } from 'node:assert/strict';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { locationId } from '@cumulo/shared';

import { SiteAdapter, storageTableName, type SitePhysics } from '../../src/index';

import { eventually, type CheckRunner } from './check-runner';
import { ENVIRONMENT, smokeSite } from './smoke-data';

/** The `cumulo-sites` checks: round trip, sparse GSI projection, fleet listing. */
export const runSiteChecks = async (
  runner: CheckRunner,
  client: DynamoDBDocumentClient,
  siteId: string,
): Promise<void> => {
  const sites = new SiteAdapter({ client, tableName: storageTableName('sites', ENVIRONMENT) });
  const site = smokeSite(siteId);
  const location = locationId(site);

  await runner.check('sites: put then get returns the identical site', async () => {
    await sites.putFleetSite(site);
    const found = await eventually(
      'sites: the site we just wrote is readable',
      () => sites.getFleetSite(siteId),
      (result) => result.found,
    );
    ok(found.found, 'expected the site to be found');
    // Deep equality is the real assertion: it proves every domain field survived
    // the round trip through the key attributes `toItem` adds and `fromItem`
    // strips, and that none of those attributes leaked back in as domain data.
    deepStrictEqual(found.site, site, 'the site read back differs from the one written');
  });

  await runner.check('sites: the sparse by-location GSI projects the physics fields', async () => {
    const physics = await eventually(
      'sites: the by-location index has caught up',
      () => sites.listActiveSitePhysicsAtLocation(location),
      (found) => found.some((entry) => entry.id === siteId),
    );
    const mine = physics.find((entry) => entry.id === siteId);
    const expected: SitePhysics = {
      id: site.id,
      latitude: site.latitude,
      longitude: site.longitude,
      tiltDegrees: site.tiltDegrees,
      azimuthDegrees: site.azimuthDegrees,
      capacityKw: site.capacityKw,
    };
    // If the INCLUDE projection in infra/storage/tables.tf ever stops covering a
    // physics field, the parse behind this call fails here and nowhere else —
    // no mock can notice a projection that omits an attribute.
    deepStrictEqual(mine, expected, 'the projected physics attributes are not what F1 needs');
  });

  await runner.check('sites: listFleetSites contains the site', async () => {
    const fleet = await eventually(
      'sites: the fleet list contains the site',
      () => sites.listFleetSites(),
      (found) => found.some((entry) => entry.id === siteId),
    );
    deepStrictEqual(
      fleet.find((entry) => entry.id === siteId),
      site,
      'the site in the fleet listing differs from the one written',
    );
  });
};
