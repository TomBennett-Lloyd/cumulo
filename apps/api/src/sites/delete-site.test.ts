import { apiErrorSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { jsonBodyOf, RANELAGH_ID, routeRequest } from '../api-fixtures';

import { deleteSite, type DeleteSiteDeps } from './delete-site';

const depsAnswering = (deleted: boolean, seen: string[] = []): DeleteSiteDeps => ({
  sites: {
    deleteFleetSite: (siteId) => {
      seen.push(siteId);
      return Promise.resolve({ deleted });
    },
  },
});

describe('DELETE /v1/sites/{siteId}', () => {
  it('answers 204 with no body when the site was there', async () => {
    const seen: string[] = [];

    const response = await deleteSite(
      depsAnswering(true, seen),
      routeRequest({ method: 'DELETE', params: { siteId: RANELAGH_ID } }),
    );

    expect(response.statusCode).toBe(204);
    expect(response.body).toBeUndefined();
    expect(seen).toEqual([RANELAGH_ID]);
  });

  it('answers 404 when there was nothing to delete', async () => {
    // A blanket 204 would tell a caller that mistyped an id that it succeeded.
    const response = await deleteSite(
      depsAnswering(false),
      routeRequest({ method: 'DELETE', params: { siteId: RANELAGH_ID } }),
    );

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('not_found');
  });

  it('answers 400 for a path id that is not a uuid, without touching the table', async () => {
    const seen: string[] = [];

    const response = await deleteSite(
      depsAnswering(true, seen),
      routeRequest({ method: 'DELETE', params: { siteId: 'not-a-uuid' } }),
    );

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(jsonBodyOf(response)).code).toBe('validation_failed');
    expect(seen).toEqual([]);
  });
});
