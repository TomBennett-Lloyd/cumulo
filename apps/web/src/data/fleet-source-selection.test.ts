import { afterEach, describe, expect, it, vi } from 'vitest';

import { DemoFleetDataSource } from './demo-fleet-data-source';
import { selectFleetDataSource } from './fleet-source-selection';
import { HttpFleetDataSource } from './http-fleet-data-source';

/** The source only ever passes `fetch` a string; anything else is a test-visible bug. */
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input !== 'string') {
    throw new Error(`expected a string request URL, received ${typeof input}`);
  }
  return input;
};

describe('selectFleetDataSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('selects the demo fleet when the variable is absent', () => {
    expect(selectFleetDataSource(undefined)).toBeInstanceOf(DemoFleetDataSource);
  });

  it('selects the demo fleet when the variable is set but blank', () => {
    // `VITE_API_BASE_URL=` in a .env file arrives as the empty string, not as
    // absent — the documented way to ask for the demo fleet explicitly.
    expect(selectFleetDataSource('')).toBeInstanceOf(DemoFleetDataSource);
    expect(selectFleetDataSource('   ')).toBeInstanceOf(DemoFleetDataSource);
  });

  it('selects the HTTP source for an https origin', () => {
    expect(selectFleetDataSource('https://api.example.test')).toBeInstanceOf(HttpFleetDataSource);
  });

  it('selects the HTTP source for an https origin with a trailing slash', () => {
    expect(selectFleetDataSource('https://api.example.test/')).toBeInstanceOf(HttpFleetDataSource);
  });

  it('selects the HTTP source for a plain http origin, which is how a local API is addressed', () => {
    expect(selectFleetDataSource('http://localhost:3000')).toBeInstanceOf(HttpFleetDataSource);
  });

  it('selects the HTTP source for a value padded with whitespace', () => {
    expect(selectFleetDataSource('  https://api.example.test  ')).toBeInstanceOf(
      HttpFleetDataSource,
    );
  });

  it('hands over a base URL that a trailing slash cannot double in a request path', async () => {
    const requests: string[] = [];
    const recordingFetch: typeof fetch = (input) => {
      requests.push(requestUrl(input));
      return Promise.resolve(new Response(JSON.stringify({ sites: [] }), { status: 200 }));
    };
    vi.stubGlobal('fetch', recordingFetch);

    await selectFleetDataSource('https://api.example.test/').listSites();

    expect(requests).toEqual(['https://api.example.test/v1/sites']);
  });

  it('throws naming the variable and the value when the value is not a URL', () => {
    expect(() => selectFleetDataSource('not a url')).toThrow(/VITE_API_BASE_URL/);
    expect(() => selectFleetDataSource('not a url')).toThrow('"not a url" is not a URL');
  });

  it('throws naming the variable and the scheme when the scheme is not http(s)', () => {
    expect(() => selectFleetDataSource('ftp://x')).toThrow(/VITE_API_BASE_URL/);
    expect(() => selectFleetDataSource('ftp://x')).toThrow('scheme "ftp:"');
  });
});
