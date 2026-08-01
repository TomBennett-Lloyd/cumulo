import { listSitesResponseSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { fleetSite, jsonBodyOf, RATHMINES_ID } from '../api-fixtures';

import { listSites, type ListSitesDeps } from './list-sites';

const depsReturning = (...sites: ReturnType<typeof fleetSite>[]): ListSitesDeps => ({
  sites: { listFleetSites: () => Promise.resolve(sites) },
});

describe('GET /v1/sites', () => {
  it('answers 200 with every site, in a body that parses as its response schema', async () => {
    const ranelagh = fleetSite();
    const rathmines = fleetSite({ id: RATHMINES_ID, name: 'Rathmines terrace', origin: 'user' });

    const response = await listSites(depsReturning(ranelagh, rathmines));

    expect(response.statusCode).toBe(200);
    expect(listSitesResponseSchema.parse(jsonBodyOf(response))).toEqual({
      sites: [ranelagh, rathmines],
    });
  });

  it('includes inactive sites — the fleet listing is the control plane, not the forecast set', async () => {
    const dormant = fleetSite({ active: false });

    const body = listSitesResponseSchema.parse(jsonBodyOf(await listSites(depsReturning(dormant))));

    expect(body.sites).toEqual([dormant]);
  });

  it('an empty fleet is 200 with an empty array, not a 404', async () => {
    const response = await listSites(depsReturning());

    expect(response.statusCode).toBe(200);
    expect(jsonBodyOf(response)).toEqual({ sites: [] });
  });
});
