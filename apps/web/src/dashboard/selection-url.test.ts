// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { readSiteIdFromSearch, writeSiteIdToUrl } from './selection-url';

/*
 * The address bar as a real address bar.
 *
 * jsdom implements `history` and `location` together, so these tests write
 * through the module and read back from `window.location` rather than
 * inspecting a mocked `replaceState` — what matters is the URL a reader would
 * copy, not that a browser API was called.
 */

/** A plausible site id: the demo fleet's ids are UUIDs, and the write must not mangle one. */
const SITE_ID = '651ceb1d-ad75-4da3-b8f4-f6e72ead1fc8';

/** Parks the window at a known URL without going through the module under test. */
const visit = (url: string): void => {
  window.history.replaceState(null, '', url);
};

beforeEach(() => {
  visit('/');
});

describe('readSiteIdFromSearch', () => {
  it('reads the site id a query string names', () => {
    expect(readSiteIdFromSearch(`?site=${SITE_ID}`)).toBe(SITE_ID);
  });

  it('reads the site id from among parameters it does not own', () => {
    expect(readSiteIdFromSearch(`?zoom=7&site=${SITE_ID}&theme=dark`)).toBe(SITE_ID);
  });

  it('reads no id from a query string that names none', () => {
    expect(readSiteIdFromSearch('')).toBeNull();
    expect(readSiteIdFromSearch('?')).toBeNull();
    expect(readSiteIdFromSearch('?zoom=7')).toBeNull();
  });

  it('treats an empty site parameter as no selection', () => {
    // `?site=` is a reader who cleared the id out of the URL by hand; it names
    // a site exactly as much as no parameter at all does.
    expect(readSiteIdFromSearch('?site=')).toBeNull();
  });
});

describe('writeSiteIdToUrl', () => {
  it('round-trips a selection through the address bar', () => {
    writeSiteIdToUrl(SITE_ID);

    expect(readSiteIdFromSearch(window.location.search)).toBe(SITE_ID);
  });

  it('takes the parameter back out when nothing is selected', () => {
    writeSiteIdToUrl(SITE_ID);
    writeSiteIdToUrl(null);

    expect(window.location.search).toBe('');
    expect(readSiteIdFromSearch(window.location.search)).toBeNull();
  });

  it('preserves parameters it does not own, writing and clearing', () => {
    visit('/?zoom=7&theme=dark#map');

    writeSiteIdToUrl(SITE_ID);

    const written = new URLSearchParams(window.location.search);

    expect(written.get('zoom')).toBe('7');
    expect(written.get('theme')).toBe('dark');
    expect(written.get('site')).toBe(SITE_ID);
    expect(window.location.hash).toBe('#map');

    writeSiteIdToUrl(null);

    const cleared = new URLSearchParams(window.location.search);

    expect(cleared.get('zoom')).toBe('7');
    expect(cleared.get('theme')).toBe('dark');
    expect(cleared.get('site')).toBeNull();
    expect(window.location.hash).toBe('#map');
  });

  it('replaces the current history entry rather than pushing a new one', () => {
    // The module's whole design decision, asserted: six marker clicks are one
    // history entry. `pushState` here would leave a reader pressing Back once
    // per site they looked at before the page finally let them leave.
    const entriesBefore = window.history.length;

    writeSiteIdToUrl(SITE_ID);
    writeSiteIdToUrl('9f0a3c2e-1111-4222-8333-444455556666');
    writeSiteIdToUrl(null);

    expect(window.history.length).toBe(entriesBefore);
  });
});
