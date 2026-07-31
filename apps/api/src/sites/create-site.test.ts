import {
  apiErrorSchema,
  fleetSiteSchema,
  utcIsoTimestampSchema,
  type FleetSite,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { jsonBodyOf, RANELAGH_ID, routeRequest, siteInput } from '../api-fixtures';

import { createSite, type CreateSiteDeps } from './create-site';

const CREATED_AT = utcIsoTimestampSchema.parse('2026-07-31T09:00:00Z');

/** Records what was written, so "the id in the body is the id that was stored" is provable. */
const recordingDeps = (
  written: FleetSite[],
  newSiteId: () => string = () => RANELAGH_ID,
): CreateSiteDeps => ({
  sites: {
    putFleetSite: (site) => {
      written.push(site);
      return Promise.resolve();
    },
  },
  now: () => CREATED_AT,
  newSiteId,
});

describe('POST /v1/sites', () => {
  it('answers 201 with the created site, id included', async () => {
    const written: FleetSite[] = [];

    const response = await createSite(
      recordingDeps(written),
      routeRequest({ method: 'POST', body: siteInput() }),
    );

    expect(response.statusCode).toBe(201);
    const body = fleetSiteSchema.parse(jsonBodyOf(response));
    // The server-assigned id is in the response body — the only legitimate way
    // for the caller to learn it.
    expect(body.id).toBe(RANELAGH_ID);
    expect(written).toEqual([body]);
  });

  it('assigns a fresh id per request rather than reusing one', async () => {
    const written: FleetSite[] = [];
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    let issued = 0;
    const deps = recordingDeps(written, () => ids[issued++] ?? '');

    await createSite(deps, routeRequest({ method: 'POST', body: siteInput() }));
    await createSite(deps, routeRequest({ method: 'POST', body: siteInput() }));

    expect(written.map((site) => site.id)).toEqual(ids);
  });

  it('sets the three fields the caller does not own', async () => {
    const written: FleetSite[] = [];

    await createSite(recordingDeps(written), routeRequest({ method: 'POST', body: siteInput() }));

    expect(written[0]?.origin).toBe('user');
    expect(written[0]?.active).toBe(true);
    expect(written[0]?.createdAt).toBe(CREATED_AT);
  });

  it('ignores an id a caller tried to choose', async () => {
    const written: FleetSite[] = [];
    const attacker = { ...siteInput(), id: '99999999-9999-4999-8999-999999999999' };

    await createSite(recordingDeps(written), routeRequest({ method: 'POST', body: attacker }));

    expect(written[0]?.id).toBe(RANELAGH_ID);
  });

  it('answers 400 naming the offending fields when the body is not a valid site', async () => {
    const written: FleetSite[] = [];

    const response = await createSite(
      recordingDeps(written),
      routeRequest({ method: 'POST', body: { ...siteInput(), capacityKw: 500, tiltDegrees: -5 } }),
    );

    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(jsonBodyOf(response));
    expect(body.code).toBe('validation_failed');
    expect(body.details?.map((detail) => detail.path)).toEqual(['tiltDegrees', 'capacityKw']);
    expect(written).toEqual([]);
  });

  it('answers 400 when there is no body at all', async () => {
    const response = await createSite(recordingDeps([]), routeRequest({ method: 'POST' }));

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('validation_failed');
  });
});
