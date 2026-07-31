import { describe, expect, it } from 'vitest';

import { StorageError } from './errors';

describe('StorageError', () => {
  it('names the operation and the table it was attempting', () => {
    const error = new StorageError(
      { operation: 'putFleetSite', table: 'cumulo-sites-dev' },
      { cause: new Error('socket hang up') },
    );

    expect(error.message).toBe(
      "storage operation 'putFleetSite' failed on table 'cumulo-sites-dev'",
    );
  });

  it('includes the item key when the operation targets one', () => {
    const error = new StorageError(
      {
        operation: 'getFleetSite',
        table: 'cumulo-sites-dev',
        key: { pk: 'FLEET', siteId: 'site-42' },
      },
      { cause: new Error('socket hang up') },
    );

    expect(error.message).toBe(
      "storage operation 'getFleetSite' failed on table 'cumulo-sites-dev' for key {pk=FLEET, siteId=site-42}",
    );
  });

  it('keeps the underlying failure reachable rather than replacing it', () => {
    const cause = new Error('ProvisionedThroughputExceededException');
    const error = new StorageError(
      { operation: 'putForecasts', table: 'cumulo-series-dev' },
      { cause },
    );

    expect(error.cause).toBe(cause);
  });

  it('exposes the context as structured data, not only as prose', () => {
    const context = {
      operation: 'querySeriesRange',
      table: 'cumulo-series-dev',
      key: { siteId: 'site-1' },
    };
    const error = new StorageError(context, { cause: 'not even an Error' });

    expect(error.context).toEqual(context);
  });

  it('is catchable as an Error and distinguishable from one', () => {
    const error = new StorageError(
      { operation: 'listFleetSites', table: 'cumulo-sites-dev' },
      { cause: new Error('boom') },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StorageError);
    expect(error.name).toBe('StorageError');
  });
});
