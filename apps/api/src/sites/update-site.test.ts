import { apiErrorSchema, fleetSiteSchema, type FleetSite } from '@cumulo/shared';
import type { GetFleetSiteResult } from '@cumulo/storage';
import { describe, expect, it } from 'vitest';

import { fleetSite, jsonBodyOf, RANELAGH_ID, routeRequest, siteInput } from '../api-fixtures';

import { updateSite, type UpdateSiteDeps } from './update-site';

const depsAround = (result: GetFleetSiteResult, written: FleetSite[] = []): UpdateSiteDeps => ({
  sites: {
    getFleetSite: () => Promise.resolve(result),
    putFleetSite: (site) => {
      written.push(site);
      return Promise.resolve();
    },
  },
});

const putRequest = (body: unknown, siteId: string = RANELAGH_ID) =>
  routeRequest({ method: 'PUT', params: { siteId }, body });

describe('PUT /v1/sites/{siteId}', () => {
  it('answers 200 with the updated site', async () => {
    const stored = fleetSite();
    const written: FleetSite[] = [];

    const response = await updateSite(
      depsAround({ found: true, site: stored }, written),
      putRequest(siteInput({ name: 'Ranelagh rooftop, rebuilt', capacityKw: 5.5 })),
    );

    expect(response.statusCode).toBe(200);
    const body = fleetSiteSchema.parse(jsonBodyOf(response));
    expect(body.name).toBe('Ranelagh rooftop, rebuilt');
    expect(body.capacityKw).toBe(5.5);
    expect(written).toEqual([body]);
  });

  it('preserves the four fields the server owns', async () => {
    // The adapter writes whole items, so a put built only from the request body
    // would re-origin a seed site as a user one and reset its eviction age.
    const stored = fleetSite({ origin: 'seed', active: false, createdAt: '2026-01-02T03:04:05Z' });
    const written: FleetSite[] = [];

    await updateSite(
      depsAround({ found: true, site: stored }, written),
      putRequest(siteInput({ name: 'renamed' })),
    );

    expect(written[0]).toEqual({ ...stored, ...siteInput({ name: 'renamed' }) });
    expect(written[0]?.id).toBe(stored.id);
    expect(written[0]?.origin).toBe('seed');
    expect(written[0]?.createdAt).toBe(stored.createdAt);
    expect(written[0]?.active).toBe(false);
  });

  it('answers 404 without writing when the site does not exist', async () => {
    const written: FleetSite[] = [];

    const response = await updateSite(
      depsAround({ found: false }, written),
      putRequest(siteInput()),
    );

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
    expect(written).toEqual([]);
  });

  it('answers 400 naming the offending field when the body is not a valid site', async () => {
    const written: FleetSite[] = [];

    const response = await updateSite(
      depsAround({ found: true, site: fleetSite() }, written),
      putRequest({ ...siteInput(), azimuthDegrees: 360 }),
    );

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.[0]?.path).toBe('azimuthDegrees');
    expect(written).toEqual([]);
  });

  it('answers 400 for a path id that is not a uuid', async () => {
    const response = await updateSite(
      depsAround({ found: true, site: fleetSite() }),
      putRequest(siteInput(), 'not-a-uuid'),
    );

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('validation_failed');
  });
});
