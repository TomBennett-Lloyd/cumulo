import { apiErrorSchema, fleetSiteSchema } from '@cumulo/shared';
import type { GetFleetSiteResult } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { fleetSite, jsonBodyOf, RANELAGH_ID, routeRequest } from '../api-fixtures';

import { getSite, type GetSiteDeps } from './get-site';

const depsAnswering = (result: GetFleetSiteResult): GetSiteDeps => ({
  sites: { getFleetSite: () => Promise.resolve(result) },
});

describe('GET /v1/sites/{siteId}', () => {
  it('answers 200 with the site when it exists', async () => {
    const site = fleetSite();

    const response = await getSite(
      depsAnswering({ found: true, site }),
      routeRequest({ params: { siteId: RANELAGH_ID } }),
    );

    expect(response.statusCode).toBe(200);
    expect(fleetSiteSchema.parse(jsonBodyOf(response))).toEqual(site);
  });

  it('answers 404 when no site has that id', async () => {
    const response = await getSite(
      depsAnswering({ found: false }),
      routeRequest({ params: { siteId: RANELAGH_ID } }),
    );

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
  });

  it('answers 400 for a path id that is not a uuid, before any read is billed', async () => {
    const deps: GetSiteDeps = {
      sites: {
        getFleetSite: () => {
          throw new Error('the adapter must not be reached for an invalid id');
        },
      },
    };

    const response = await getSite(deps, routeRequest({ params: { siteId: 'not-a-uuid' } }));

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.[0]?.path).toBe('siteId');
  });
});
