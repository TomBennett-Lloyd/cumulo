import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { apiErrorSchema } from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { jsonBodyOf, routeRequest } from '../api-fixtures';

import { docsAssetParamName, docsAssets } from './docs-assets';
import { docsPageResponse, serveDocsAsset, type DocsAssetDeps } from './docs-page';

/**
 * These tests read the **real** `swagger-ui-dist` files — the same pinned copy
 * `scripts/copy-swagger-assets.mjs` puts into `dist/swagger/`, resolved through
 * the module resolver rather than by guessing at a `node_modules` path. Stubbing
 * the filesystem here would prove that a mock returns what it was told to; what
 * is worth proving is that the allowlist names files this package actually
 * contains, and that a 1.5 MB bundle survives the encoding on the way out.
 */

const swaggerUiPackage = createRequire(import.meta.url).resolve('swagger-ui-dist/package.json');

const deps: DocsAssetDeps = {
  assetDirectory: new URL('.', pathToFileURL(swaggerUiPackage)),
};

const assetRequest = (name: string): ReturnType<typeof routeRequest> =>
  routeRequest({ method: 'GET', path: `/docs/${name}`, params: { [docsAssetParamName]: name } });

/** Every `/docs/<name>` the page loads, in the order the page loads them. */
const referencedAssetNames = (html: string): string[] =>
  [...html.matchAll(/["']\/docs\/([^"']+)["']/g)].map((match) => String(match[1]));

/** The page body, named once so the assertions below read as assertions. */
const docsPageBody = (): string => docsPageResponse().body ?? '';

describe('the /docs page', () => {
  it('is HTML that points Swagger UI at this service’s own document', () => {
    const response = docsPageResponse();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('<div id="swagger-ui">');
    // A relative URL, so "try it out" runs against the origin serving the page
    // — the property ADR 0005 chose this hosting shape for.
    expect(response.body).toContain("url: '/openapi.json'");
  });

  it('credits Open-Meteo on the page that renders their data', () => {
    // CLAUDE.md's attribution constraint is about display, and this page
    // displays weather-derived data the moment a reviewer presses "try it out".
    const body = docsPageBody();

    expect(body).toContain('Weather data by');
    expect(body).toContain('https://open-meteo.com/');
  });

  it('loads only assets the allowlist will serve', () => {
    const referenced = referencedAssetNames(docsPageBody());

    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect([...docsAssets.keys()], `the page loads /docs/${name}`).toContain(name);
    }
  });
});

describe('the /docs/{asset} allowlist', () => {
  it('serves the stylesheet as CSS', async () => {
    const served = await serveDocsAsset(deps, assetRequest('swagger-ui.css'));

    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(served.body).toContain('.swagger-ui');
    expect(served.isBase64Encoded).toBe(false);
  });

  it('serves the bundle as JavaScript, whole', async () => {
    const served = await serveDocsAsset(deps, assetRequest('swagger-ui-bundle.js'));

    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(served.isBase64Encoded).toBe(false);
    // The one asset big enough for Lambda's 6 MB response limit to be worth a
    // thought: ~1.5 MB of text, which is what the check below is sizing.
    expect((served.body ?? '').length).toBeGreaterThan(1_000_000);
    expect(Buffer.byteLength(served.body ?? '')).toBeLessThan(6 * 1024 * 1024);
  });

  it('base64-encodes the one binary asset, and says so', async () => {
    const served = await serveDocsAsset(deps, assetRequest('favicon-32x32.png'));

    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.isBase64Encoded).toBe(true);
    // Decoded, the bytes are still a PNG — which is what the gateway will hand
    // to the browser when it honours the flag above.
    expect([...Buffer.from(served.body ?? '', 'base64').subarray(0, 4)]).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
  });

  it('caches assets but not the page, because only one of them is version-pinned', async () => {
    const served = await serveDocsAsset(deps, assetRequest('swagger-ui.css'));

    expect(served.headers['cache-control']).toBe('public, max-age=3600');
    expect(docsPageResponse().headers['cache-control']).toBe('no-cache');
  });

  it.each([
    ['a file that exists in the package but is not allowlisted', 'swagger-ui-bundle.js.map'],
    ['a traversal attempt', '../package.json'],
    ['an encoded traversal attempt', '..%2Fmain.mjs'],
    ['an absolute path', '/etc/passwd'],
    ['the empty name', ''],
  ])('404s %s', async (_case, name) => {
    // None of these is defended against by string handling: the name is a key
    // into a Map and never becomes a path, so every miss takes one code path.
    const served = await serveDocsAsset(deps, assetRequest(name));

    expect(served.statusCode).toBe(404);
    expect(apiErrorSchema.parse(jsonBodyOf(served)).code).toBe('not_found');
  });

  it('404s a request whose path parameter never arrived', async () => {
    const served = await serveDocsAsset(deps, routeRequest({ path: '/docs/' }));

    expect(served.statusCode).toBe(404);
  });
});
